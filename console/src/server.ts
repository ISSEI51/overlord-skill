/**
 * Overlord Console: a localhost dashboard for docs/product-ops/board.yaml that
 * drives cmux agent sessions over the cmux CLI.
 *
 * The server binds to the loopback interface only and rejects requests whose
 * Host or Origin header is not loopback, so a page on another site cannot
 * reach it through DNS rebinding and type into the user's agent terminals.
 */

import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as cmux from "./cmux.ts";
import * as cmuxSocket from "./cmux-socket.ts";
import {
  BoardConflictError,
  boardPathFor,
  canonicalItem,
  loadBoard,
  mutateBoard,
  nowIso,
  projectRootFor,
  revisionOf,
  STATES,
  type Board,
  type Item,
  type SessionLink,
  type State,
} from "./board.ts";

type Options = { boardPath: string; port: number; open: boolean };

function parseArgs(argv: string[]): Options {
  let target = process.cwd();
  let port = Number(process.env.OVERLORD_PORT ?? 7377);
  let open = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--board" || arg === "--project") {
      target = argv[++index] ?? target;
    } else if (arg === "--port") {
      port = Number(argv[++index] ?? port);
    } else if (arg === "--open") {
      open = true;
    } else if (!arg.startsWith("-")) {
      target = arg;
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  return { boardPath: boardPathFor(target), port, open };
}

const options = parseArgs(process.argv.slice(2));
const publicDir = resolve(import.meta.dir, "../public");

/* ---------------------------------------------------------------- events */

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

function broadcast(event: unknown): void {
  const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const client of clients) {
    try {
      client.enqueue(frame);
    } catch {
      clients.delete(client);
    }
  }
}

let watcher: FSWatcher | null = null;
let lastRev = "";
let debounce: ReturnType<typeof setTimeout> | null = null;

function watchBoard(): void {
  const directory = dirname(options.boardPath);
  const name = basename(options.boardPath);
  try {
    watcher = watch(directory, (_event, filename) => {
      if (filename && filename !== name) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const rev = await revisionOf(options.boardPath);
        if (rev === lastRev) return;
        lastRev = rev;
        broadcast({ type: "board", rev });
      }, 150);
    });
  } catch (error) {
    console.warn(`board watch unavailable: ${String(error)}`);
  }
}

/* --------------------------------------------------------- cmux activity */

/**
 * cmux events that carry a surface_id or workspace_id become lightweight
 * {type:"activity"} SSE frames (no content — the frontend re-reads the
 * screen itself). A 300 ms trailing debounce per key (surface_id, falling
 * back to workspace_id) coalesces event bursts into one frame. Losing
 * stream continuity (cmux restart or dropped events) broadcasts an
 * activity frame with both ids null: "refresh everything".
 */
const ACTIVITY_DEBOUNCE_MS = 300;
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleActivity(surfaceId: string | null, workspaceId: string | null): void {
  const key = surfaceId ?? workspaceId ?? "*";
  const existing = activityTimers.get(key);
  if (existing) clearTimeout(existing);
  activityTimers.set(
    key,
    setTimeout(() => {
      activityTimers.delete(key);
      broadcast({ type: "activity", surface_id: surfaceId, workspace_id: workspaceId });
    }, ACTIVITY_DEBOUNCE_MS),
  );
}

/**
 * Start the event subscription. subscribeEvents never throws (connection
 * failures are retried internally with backoff), so a broken subscription
 * can never take the server down.
 */
function watchCmuxActivity(): () => void {
  try {
    return cmuxSocket.subscribeEvents({
      onEvent(event) {
        if (event.surfaceId === null && event.workspaceId === null) return;
        scheduleActivity(event.surfaceId, event.workspaceId);
      },
      onResync() {
        broadcast({ type: "activity", surface_id: null, workspace_id: null });
      },
    });
  } catch (error) {
    console.warn(`cmux event subscription unavailable: ${String(error)}`);
    return () => undefined;
  }
}

/* ----------------------------------------------------------------- utils */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostAllowed(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "");
  if (!LOOPBACK.has(hostname)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!LOOPBACK.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  if (request.method !== "GET" && request.headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }
  return true;
}

async function body<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rejection raised from inside a `mutateBoard` callback. Throwing aborts the
 * write, so a request that turns out to be invalid only after the board was
 * read (unknown item, non-editable field) leaves the file untouched.
 */
class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

/** Record the revision this server just wrote and tell the clients. */
function announce(rev: string): void {
  lastRev = rev;
  broadcast({ type: "board", rev });
}

/** Turn a failed board write into the response the frontend expects. */
function boardFailure(error: unknown): Response {
  if (error instanceof BoardConflictError) {
    return json({ error: error.message, rev: error.rev }, 409);
  }
  if (error instanceof RequestError) return fail(error.message, error.status);
  throw error;
}

/* ------------------------------------------------------------- board API */

const PATCHABLE = new Set([
  "state",
  "owner",
  "next_action",
  "blocker",
  "title",
  "project",
  "evidence",
  "out_of_scope",
  "acceptance_conditions",
  "priority",
  "agent",
  "changes",
]);

async function patchItem(request: Request, id: string): Promise<Response> {
  const payload = await body<{ rev?: string; patch?: Record<string, unknown> }>(
    request,
  );
  const patch = payload.patch ?? {};
  try {
    const { rev, result } = await mutateBoard(
      options.boardPath,
      payload.rev,
      (board) => {
        const item = board.items.find((entry) => entry.id === id);
        if (!item) throw new RequestError(`unknown item: ${id}`, 404);
        for (const [key, value] of Object.entries(patch)) {
          if (!PATCHABLE.has(key)) {
            throw new RequestError(`field not editable: ${key}`);
          }
          if (key === "state" && !STATES.includes(value as State)) {
            throw new RequestError(`unknown state: ${String(value)}`);
          }
          (item as Record<string, unknown>)[key] = value;
        }
        item.updated_at = nowIso();
        const index = board.items.indexOf(item);
        board.items[index] = canonicalItem(item);
        return board.items[index]!;
      },
    );
    announce(rev);
    return json({ item: result, rev });
  } catch (error) {
    return boardFailure(error);
  }
}

async function deleteItem(request: Request, id: string): Promise<Response> {
  const payload = await body<{ rev?: string }>(request);
  try {
    const { rev } = await mutateBoard(options.boardPath, payload.rev, (board) => {
      const index = board.items.findIndex((entry) => entry.id === id);
      if (index === -1) throw new RequestError(`unknown item: ${id}`, 404);
      if (board.items[index]!.state !== "done") {
        throw new RequestError("only done items can be deleted");
      }
      board.items.splice(index, 1);
    });
    announce(rev);
    return json({ ok: true, rev });
  } catch (error) {
    return boardFailure(error);
  }
}

/**
 * Create a card. `rev` is optional here and only here: the frontend's create
 * dialog does not hold a revision, and a create never overwrites an existing
 * card, so an omitted `rev` writes without an optimistic check exactly as it
 * did before. A caller that does send `rev` gets the same 409 as the other
 * write endpoints. Either way the write runs through the serialized board
 * write path, so a concurrent edit is no longer overwritten wholesale.
 *
 * `project` is not part of the payload: the server derives it from the board
 * (see `inheritedProject`), and `PATCH /api/items/:id` sets it for the cases
 * that cannot be derived.
 */
async function createItem(request: Request): Promise<Response> {
  const payload = await body<{
    rev?: string;
    title?: string;
    state?: State;
    evidence?: string;
  }>(request);
  const title = (payload.title ?? "").trim();
  if (!title) return fail("title is required");
  try {
    const { rev, result } = await mutateBoard(
      options.boardPath,
      payload.rev,
      (board) => {
        const item = canonicalItem({
          id: nextId(board),
          project: inheritedProject(board),
          title,
          state:
            payload.state && STATES.includes(payload.state) ? payload.state : "inbox",
          evidence: payload.evidence ?? null,
          owner: null,
          next_action: null,
          blocker: null,
          updated_at: nowIso(),
        } as Item);
        board.items.unshift(item);
        return item;
      },
    );
    announce(rev);
    return json({ item: result, rev });
  } catch (error) {
    return boardFailure(error);
  }
}

/**
 * Id for a new card: the prefix the board already uses, one past the highest
 * number on it.
 *
 * The prefix used to be built from the request's `project`, so a card created
 * with project "Overlord" landed as `OVER-111` on a board of `OV-` cards, and
 * nothing on screen said so. No field of a create request selects it now.
 */
function nextId(board: Board): string {
  let max = 0;
  for (const item of board.items) {
    const match = item.id.match(/(\d+)\s*$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${idPrefix(board)}-${String(max + 1).padStart(3, "0")}`;
}

/** The prefix most card ids on the board use; `OV` when the board has none. */
function idPrefix(board: Board): string {
  const counts = new Map<string, number>();
  for (const item of board.items) {
    const match = item.id.match(/^([A-Za-z][A-Za-z0-9-]*)-\d+\s*$/);
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  let prefix = "OV";
  let best = 0;
  for (const [candidate, count] of counts) {
    if (count > best) {
      prefix = candidate;
      best = count;
    }
  }
  return prefix;
}

/**
 * `project` for a new card, decided from the board instead of asked for.
 *
 * A board that names exactly one project gives every new card that project; a
 * board that mixes projects, or names none, leaves it null because there is
 * nothing to infer. `PATCH /api/items/:id` still writes `project`, so the
 * mixed-board case stays reachable.
 */
function inheritedProject(board: Board): string | null {
  const projects = new Set<string>();
  for (const item of board.items) {
    if (typeof item.project === "string" && item.project !== "") {
      projects.add(item.project);
    }
  }
  return projects.size === 1 ? [...projects][0]! : null;
}

/**
 * The commander is the single cmux session the user talks to in the console.
 * It is board-level state, not per-card state: the console never picks a
 * session per work item.
 */
async function setCommander(request: Request): Promise<Response> {
  const payload = await body<{ rev?: string; commander?: SessionLink | null }>(
    request,
  );
  try {
    const { rev, result } = await mutateBoard(
      options.boardPath,
      payload.rev,
      (board) => {
        board.commander = payload.commander ?? null;
        return board.commander;
      },
    );
    announce(rev);
    return json({ commander: result, rev });
  } catch (error) {
    return boardFailure(error);
  }
}

/* -------------------------------------------------------------- cmux API */

async function cmuxSend(request: Request): Promise<Response> {
  const payload = await body<{ surface?: string; text?: string; submit?: boolean }>(request);
  if (!payload.surface) return fail("surface is required");
  if (typeof payload.text !== "string" || payload.text.length === 0) {
    return fail("text is required");
  }
  await cmux.sendText(payload.surface, payload.text, payload.submit !== false);
  return json({ ok: true });
}

async function cmuxKey(request: Request): Promise<Response> {
  const payload = await body<{ surface?: string; key?: string }>(request);
  if (!payload.surface || !payload.key) return fail("surface and key are required");
  await cmux.sendKey(payload.surface, payload.key);
  return json({ ok: true });
}

async function cmuxWorkspace(request: Request): Promise<Response> {
  const payload = await body<{ name?: string; cwd?: string; command?: string; description?: string }>(
    request,
  );
  if (!payload.name || !payload.cwd) return fail("name and cwd are required");
  const created = await cmux.createWorkspace({
    name: payload.name,
    cwd: payload.cwd,
    command: payload.command,
    description: payload.description,
  });
  const workspaces = await cmux.listWorkspaces();
  const workspace = workspaces.find((entry) => entry.ref === created.workspaceRef);
  return json({ created, workspace });
}

/* -------------------------------------------------------------- requests */

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/events") {
    let self: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        if (self) clients.delete(self);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  if (path === "/api/state" && request.method === "GET") {
    const [{ board, rev, exists }, cmuxUp] = await Promise.all([
      loadBoard(options.boardPath),
      cmux.available(),
    ]);
    lastRev = rev;
    let workspaces: cmux.Workspace[] = [];
    let cmuxError: string | null = null;
    if (cmuxUp) {
      try {
        workspaces = await cmux.listWorkspaces();
      } catch (error) {
        cmuxError = errorMessage(error);
      }
    }
    return json({
      board,
      rev,
      exists,
      boardPath: options.boardPath,
      projectRoot: projectRootFor(options.boardPath),
      cmux: { available: cmuxUp, error: cmuxError, workspaces },
    });
  }

  if (path === "/api/items" && request.method === "POST") return createItem(request);

  const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch && request.method === "PATCH") {
    return patchItem(request, decodeURIComponent(itemMatch[1]!));
  }
  if (itemMatch && request.method === "DELETE") {
    return deleteItem(request, decodeURIComponent(itemMatch[1]!));
  }

  if (path === "/api/commander" && request.method === "PUT") {
    return setCommander(request);
  }

  if (path === "/api/cmux/workspaces" && request.method === "GET") {
    return json({ workspaces: await cmux.listWorkspaces() });
  }

  if (path === "/api/cmux/screen" && request.method === "GET") {
    const surface = url.searchParams.get("surface");
    if (!surface) return fail("surface is required");
    const lines = Number(url.searchParams.get("lines") ?? 80);
    const scrollback = url.searchParams.get("scrollback") === "1";
    const text = await cmux.readScreen(surface, Number.isFinite(lines) ? lines : 80, scrollback);
    return json({ text });
  }

  if (path === "/api/cmux/send" && request.method === "POST") return cmuxSend(request);
  if (path === "/api/cmux/key" && request.method === "POST") return cmuxKey(request);
  if (path === "/api/cmux/workspace" && request.method === "POST") return cmuxWorkspace(request);

  if (path === "/api/cmux/focus" && request.method === "POST") {
    const payload = await body<{ workspace?: string; surfaceId?: string }>(request);
    if (payload.workspace) await cmux.focusWorkspace(payload.workspace);
    if (payload.surfaceId) await cmux.focusSurface(payload.surfaceId);
    return json({ ok: true });
  }

  if (request.method !== "GET") return fail("not found", 404);

  const name = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  if (name.includes("..")) return fail("not found", 404);
  const file = Bun.file(join(publicDir, name));
  if (await file.exists()) {
    return new Response(file, { headers: { "cache-control": "no-store" } });
  }
  return fail("not found", 404);
}

/* ----------------------------------------------------------------- start */

watchBoard();
const stopCmuxActivity = watchCmuxActivity();

// Keep proxies and browsers from dropping idle event streams.
setInterval(() => {
  const frame = encoder.encode(": ping\n\n");
  for (const client of clients) {
    try {
      client.enqueue(frame);
    } catch {
      clients.delete(client);
    }
  }
}, 25_000);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: options.port,
  idleTimeout: 0,
  async fetch(request) {
    if (!hostAllowed(request)) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      return await handle(request);
    } catch (error) {
      if (error instanceof cmux.CmuxError) return fail(error.message, 502);
      return fail(errorMessage(error), 500);
    }
  },
});

const address = `http://127.0.0.1:${server.port}`;
console.log(`Overlord Console  ${address}`);
console.log(`board             ${options.boardPath}`);
console.log(`cmux              ${(await cmux.available()) ? "connected" : "not reachable"}`);

if (options.open) {
  const result = await cmux.run(["browser", "open", address]);
  if (result.code !== 0) {
    console.warn(`cmux browser open failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

process.on("SIGINT", () => {
  stopCmuxActivity();
  watcher?.close();
  server.stop(true);
  process.exit(0);
});
