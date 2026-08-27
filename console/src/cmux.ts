/**
 * cmux CLI wrapper.
 *
 * All cmux control goes through the `cmux` binary, which talks to the running
 * cmux app over its local Unix socket. No other transport is used.
 */

import * as cmuxSocket from "./cmux-socket.ts";

const FALLBACK_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const DEFAULT_TIMEOUT_MS = 10_000;

export type CmuxResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type Surface = {
  ref: string;
  id: string;
  title: string;
  type: string;
  tty: string | null;
  url: string | null;
  selected: boolean;
  focused: boolean;
};

export type Workspace = {
  ref: string;
  id: string;
  title: string;
  index: number;
  selected: boolean;
  cwd: string | null;
  latestMessage: string | null;
  surfaces: Surface[];
};

let resolvedBin: string | null | undefined;

async function resolveBin(): Promise<string | null> {
  if (resolvedBin !== undefined) return resolvedBin;
  const candidates = [process.env.CMUX_BIN, FALLBACK_BIN].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const onPath = Bun.which("cmux");
  if (onPath) candidates.unshift(onPath);
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      resolvedBin = candidate;
      return resolvedBin;
    }
  }
  resolvedBin = null;
  return resolvedBin;
}

export async function run(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CmuxResult> {
  const bin = await resolveBin();
  if (!bin) {
    return {
      code: 127,
      stdout: "",
      stderr: "cmux CLI not found. Set CMUX_BIN to the cmux binary path.",
      timedOut: false,
    };
  }
  const proc = Bun.spawn([bin, ...args], {
    env: { ...process.env, CMUX_QUIET: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export class CmuxError extends Error {
  constructor(
    message: string,
    readonly result: CmuxResult,
  ) {
    super(message);
  }
}

async function runOrThrow(args: string[], timeoutMs?: number): Promise<string> {
  const result = await run(args, timeoutMs);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CmuxError(
      result.timedOut
        ? `cmux ${args[0]} timed out`
        : `cmux ${args[0]} exited with code ${result.code}: ${detail}`,
      result,
    );
  }
  return result.stdout;
}

async function runJson<T>(args: string[], timeoutMs?: number): Promise<T> {
  const stdout = await runOrThrow(args, timeoutMs);
  return JSON.parse(stdout) as T;
}

export async function available(): Promise<boolean> {
  const result = await run(["ping"], 3_000);
  return result.code === 0 && result.stdout.trim() === "PONG";
}

type TreeJson = {
  windows: Array<{
    ref: string;
    id: string;
    workspaces: Array<{
      ref: string;
      id: string;
      title: string;
      index: number;
      selected: boolean;
      panes: Array<{ surfaces: Surface[] }>;
    }>;
  }>;
};

type WorkspaceListJson = {
  workspaces: Array<{
    id: string;
    ref: string;
    current_directory: string | null;
    latest_conversation_message: string | null;
  }>;
};

/** Flat workspace list with their terminal surfaces, for the console picker. */
export async function listWorkspaces(): Promise<Workspace[]> {
  const [tree, meta] = await Promise.all([
    runJson<TreeJson>(["tree", "--all", "--json", "--id-format", "both"]),
    runJson<WorkspaceListJson>(["workspace", "list", "--json"]).catch(
      () => ({ workspaces: [] }) as WorkspaceListJson,
    ),
  ]);
  const byId = new Map(meta.workspaces.map((entry) => [entry.id, entry]));
  const workspaces: Workspace[] = [];
  for (const window of tree.windows ?? []) {
    for (const workspace of window.workspaces ?? []) {
      const extra = byId.get(workspace.id);
      workspaces.push({
        ref: workspace.ref,
        id: workspace.id,
        title: workspace.title,
        index: workspace.index,
        selected: workspace.selected,
        cwd: extra?.current_directory ?? null,
        latestMessage: extra?.latest_conversation_message ?? null,
        surfaces: (workspace.panes ?? []).flatMap((pane) => pane.surfaces ?? []),
      });
    }
  }
  return workspaces;
}

/**
 * A cmux workspace does not start its terminal process until the workspace is
 * selected for the first time; until then the surface reports `tty: null` and
 * every terminal command fails. Selecting the workspace once starts it. The
 * previously selected workspace is restored so the console keeps the user in
 * place.
 */
const startedSurfaces = new Set<string>();

export async function startTerminal(surface: string): Promise<boolean> {
  const workspaces = await listWorkspaces();
  const owner = workspaces.find((workspace) =>
    workspace.surfaces.some(
      (entry) => entry.id === surface || entry.ref === surface,
    ),
  );
  if (!owner) return false;
  const previous = workspaces.find((workspace) => workspace.selected);
  await focusWorkspace(owner.ref);
  await Bun.sleep(1_200);
  if (previous && previous.ref !== owner.ref) {
    await focusWorkspace(previous.ref).catch(() => undefined);
  }
  startedSurfaces.add(surface);
  return true;
}

/** Run a terminal command, starting the surface's terminal once if needed. */
async function withTerminal<T>(
  surface: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof CmuxError) || startedSurfaces.has(surface)) throw error;
    if (!(await startTerminal(surface))) throw error;
    return action();
  }
}

const UUID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function readScreenArgs(surface: string, lines: number, scrollback: boolean): string[] {
  const args = ["read-screen", "--surface", surface, "--lines", String(lines)];
  if (scrollback) args.push("--scrollback");
  return args;
}

function readScreenViaCli(
  surface: string,
  lines: number,
  scrollback: boolean,
): Promise<string> {
  return withTerminal(surface, () => runOrThrow(readScreenArgs(surface, lines, scrollback)));
}

/**
 * surface.read_text over the cmux socket. The CLI prints the same text plus
 * a trailing newline (measured byte-for-byte), so the newline is appended
 * here to keep /api/cmux/screen byte-identical with the CLI transport.
 * RPC failures (ok:false) become CmuxError so withTerminal's one-shot
 * terminal start still applies; transport failures stay
 * CmuxSocketUnavailable so callers can fall back to the CLI.
 */
async function readTextViaSocket(
  surfaceId: string,
  lines: number,
  scrollback: boolean,
): Promise<string> {
  try {
    const result = await cmuxSocket.request<{ text: string }>("surface.read_text", {
      surface_id: surfaceId,
      lines,
      scrollback,
    });
    return `${result.text}\n`;
  } catch (error) {
    if (error instanceof cmuxSocket.CmuxRpcError) {
      const detail = `${error.code}: ${error.message}`;
      throw new CmuxError(`cmux surface.read_text failed: ${detail}`, {
        code: 1,
        stdout: "",
        stderr: detail,
        timedOut: false,
      });
    }
    throw error;
  }
}

/**
 * Scrollback reads run one socket/CLI equivalence self-check per process:
 * the first scrollback request fetches through both transports and compares
 * bytes. On a match every later read stays on the socket; on a mismatch all
 * later scrollback reads use the CLI. If the socket is unreachable the
 * check is deferred to the next scrollback request.
 */
let scrollbackTransport: "unchecked" | "socket" | "cli" = "unchecked";

async function scrollbackSelfCheck(surface: string, lines: number): Promise<string> {
  let viaSocket: string;
  try {
    viaSocket = await withTerminal(surface, () => readTextViaSocket(surface, lines, true));
  } catch (error) {
    if (error instanceof cmuxSocket.CmuxSocketUnavailable) {
      return readScreenViaCli(surface, lines, true);
    }
    throw error;
  }
  const viaCli = await runOrThrow(readScreenArgs(surface, lines, true));
  scrollbackTransport = viaSocket === viaCli ? "socket" : "cli";
  return scrollbackTransport === "socket" ? viaSocket : viaCli;
}

/**
 * Read a terminal surface's screen (or scrollback) text.
 *
 * The socket transport (surface.read_text) is used whenever possible; the
 * CLI remains the fallback for (a) non-UUID surface identifiers, (b) an
 * unreachable socket, and (c) scrollback reads after a failed self-check.
 */
export async function readScreen(
  surface: string,
  lines: number,
  scrollback: boolean,
): Promise<string> {
  if (!UUID_PATTERN.test(surface)) return readScreenViaCli(surface, lines, scrollback);
  if (scrollback) {
    if (scrollbackTransport === "cli") return readScreenViaCli(surface, lines, true);
    if (scrollbackTransport === "unchecked") return scrollbackSelfCheck(surface, lines);
  }
  try {
    return await withTerminal(surface, () => readTextViaSocket(surface, lines, scrollback));
  } catch (error) {
    if (error instanceof cmuxSocket.CmuxSocketUnavailable) {
      return readScreenViaCli(surface, lines, scrollback);
    }
    throw error;
  }
}

/**
 * Send text to a terminal surface.
 *
 * cmux injects `surface.send_text` / `terminal.input` text as per-character
 * key events, so hand-built bracketed-paste markers (ESC[200~ ... ESC[201~)
 * are not recognized by the Claude Code TUI: each ESC arrives as a standalone
 * Escape keypress and "[200~" is inserted literally (OV-014). Instead:
 *
 * - submit: one `terminal.paste` call. cmux pastes the whole (multi-line)
 *   text as a single block and submits it itself; the response reports
 *   `submitted`. If cmux could not submit, Enter is sent as a fallback.
 * - no submit: `terminal.input` per line. `terminal.input` turns "\n" into
 *   Enter (which would submit every line), so newlines are inserted with a
 *   shift+enter key event between lines instead.
 *
 * Requires the surface UUID, not a ref.
 */
export async function sendText(
  surfaceId: string,
  text: string,
  submit: boolean,
): Promise<void> {
  const clean = sanitize(text);
  if (submit) {
    const stdout = await withTerminal(surfaceId, () =>
      runOrThrow([
        "rpc",
        "terminal.paste",
        JSON.stringify({ surface_id: surfaceId, text: clean }),
      ]),
    );
    let submitted = false;
    try {
      submitted = (JSON.parse(stdout) as { submitted?: boolean }).submitted === true;
    } catch {
      submitted = false;
    }
    if (!submitted) await sendKey(surfaceId, "enter");
    return;
  }
  const lines = clean.split("\n");
  await withTerminal(surfaceId, async () => {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        await runOrThrow(["send-key", "--surface", surfaceId, "--", "shift+enter"]);
      }
      const line = lines[i];
      if (line && line.length > 0) {
        await runOrThrow([
          "rpc",
          "terminal.input",
          JSON.stringify({ surface_id: surfaceId, text: line }),
        ]);
      }
    }
  });
}

/** Drop control characters that would end the paste or drive the TUI. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export async function sendKey(surface: string, key: string): Promise<void> {
  await withTerminal(surface, () =>
    runOrThrow(["send-key", "--surface", surface, "--", key]),
  );
}

export async function createWorkspace(options: {
  name: string;
  cwd: string;
  command?: string;
  description?: string;
}): Promise<{ workspaceRef: string | null; raw: string }> {
  const args = ["new-workspace", "--name", options.name, "--cwd", options.cwd];
  if (options.command) args.push("--command", options.command);
  if (options.description) args.push("--description", options.description);
  const stdout = await runOrThrow(args, 20_000);
  const match = stdout.match(/workspace:\d+/);
  const workspaceRef = match ? match[0] : null;
  if (workspaceRef) {
    // Start the terminal so the workspace can receive input right away.
    const workspaces = await listWorkspaces();
    const created = workspaces.find((entry) => entry.ref === workspaceRef);
    const surface = created?.surfaces.find((entry) => entry.type === "terminal");
    if (surface && !surface.tty) await startTerminal(surface.id);
  }
  return { workspaceRef, raw: stdout.trim() };
}

export async function focusWorkspace(workspace: string): Promise<void> {
  await runOrThrow(["select-workspace", "--workspace", workspace]);
}

/** Focus one surface in the cmux UI. Requires the surface UUID, not a ref. */
export async function focusSurface(surfaceId: string): Promise<void> {
  await runOrThrow(["rpc", "surface.focus", JSON.stringify({ surface_id: surfaceId })]);
}
