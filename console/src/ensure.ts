/**
 * The `ensure` command behind `scripts/console.sh ensure`.
 *
 * The shell launcher only checks for bun and hands over; the decisions live
 * here, the same split `change.sh` / `change.ts` uses.
 *
 * The steps are fixed, and each one is a no-op when it is already done, so
 * running the command again produces the same result:
 *
 *   1. resolve the board path of the target project. The project directory
 *      itself has to exist: `ensure` writes into it, it does not create it;
 *   2. probe the port. A console already serving this board is left running
 *      and nothing else is started, and the run goes straight to step 5;
 *   3. create `docs/product-ops/board.yaml` when it does not exist, before
 *      the server starts. The server watches the board's *directory*, once,
 *      at startup: `watchBoard` fails with ENOENT when `docs/product-ops` is
 *      missing and is never retried, so a server started against a missing
 *      board runs without a watcher for the rest of its life and board writes
 *      reach the browser only through the frontend's 15 s poll instead of the
 *      150 ms SSE frame;
 *   4. start the server. With cmux reachable it runs in a cmux workspace the
 *      user can see and close; otherwise it is started detached and the
 *      command that stops it is printed;
 *   5. register the calling cmux session as the commander. This happens on
 *      the already running path too, so a second session can take an
 *      existing console over; an unchanged commander is not written back.
 *
 * The browser is never opened by this command on its own. `--open` is passed
 * to the server exactly as `console.sh <project> --open` does.
 */

import { closeSync, openSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import * as cmux from "./cmux.ts";
import {
  EMPTY_BOARD,
  boardPathFor,
  loadBoard,
  mutateBoard,
  projectRootFor,
  saveBoard,
  type Board,
  type SessionLink,
} from "./board.ts";

/** Server entry point and shell launcher, resolved from this file. */
const SERVER_PATH = resolve(import.meta.dir, "server.ts");
const CONSOLE_SH = resolve(import.meta.dir, "../../scripts/console.sh");

/** How long a single `/api/state` probe is allowed to take. */
const PROBE_TIMEOUT_MS = 2_000;
/** How long the started server has to answer `/api/state`. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

export type Options = {
  boardPath: string;
  port: number;
  open: boolean;
};

/**
 * Same argument shape as the server itself, so `console.sh ensure <project>
 * --port <n> --open` and `console.sh <project> --port <n> --open` take the
 * same words in the same places.
 */
export function parseArgs(argv: string[]): Options {
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
    } else if (arg === "--help" || arg === "-h") {
      // Answered by `ensure` before it parses; accepted here so that parsing
      // a help line on its own does not throw instead.
    } else if (arg.startsWith("-")) {
      // A mistyped option used to be dropped without a word, and its value
      // was then taken as the project: `--prot 7420` served `./7420`.
      throw new Error(`unknown option: ${arg} (see: console.sh ensure --help)`);
    } else {
      target = arg;
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  return { boardPath: boardPathFor(target), port, open };
}

/* ------------------------------------------------------------------ probe */

/**
 * What is listening on the port.
 *
 * `console` is an Overlord console and reports the board it serves;
 * `foreign` is something that answers HTTP but is not one, which is a reason
 * to stop rather than to pick another port.
 */
export type Probe =
  | { kind: "absent" }
  | { kind: "console"; boardPath: string }
  | { kind: "foreign"; detail: string };

export async function probeConsole(
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Nothing is listening. Every other transport failure (a socket that
    // accepts and never answers, a TLS listener) is reported as foreign,
    // because something does hold the port.
    if ((error as { code?: string }).code === "ConnectionRefused") {
      return { kind: "absent" };
    }
    return { kind: "foreign", detail: (error as Error).message };
  }
  if (!response.ok) {
    return { kind: "foreign", detail: `/api/state answered ${response.status}` };
  }
  let payload: { boardPath?: unknown };
  try {
    payload = (await response.json()) as { boardPath?: unknown };
  } catch {
    return { kind: "foreign", detail: "/api/state did not answer JSON" };
  }
  if (typeof payload.boardPath !== "string") {
    return { kind: "foreign", detail: "/api/state carries no boardPath" };
  }
  return { kind: "console", boardPath: resolve(payload.boardPath) };
}

/** Wait until the port serves `boardPath`, or give up. */
async function waitForConsole(options: Options): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const probe = await probeConsole(options.port);
    if (probe.kind === "console" && probe.boardPath === options.boardPath) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(READY_POLL_MS);
  }
}

/* ------------------------------------------------------------------ board */

/**
 * `loadBoard`, with the board path in the message when the file cannot be
 * read. `Bun.YAML.parse` reports only what it found (`YAML Parse error:
 * Multiline implicit key`), which does not say which file to go and fix.
 */
async function readBoard(boardPath: string): Promise<{ board: Board; exists: boolean }> {
  try {
    return await loadBoard(boardPath);
  } catch (error) {
    throw new Error(`cannot read the board ${boardPath}: ${(error as Error).message}`);
  }
}

/**
 * Create the minimal board when there is none, and report whether it was
 * created. Only the skeleton (`version`, `updated_at`, `items: []`) is
 * written; filling the board is product work, not a launcher's job. An
 * existing board is never read back out and written again, so its items keep
 * their exact bytes.
 *
 * A refused write is reported against the board path. `saveBoard` writes
 * through `<board>.overlord-tmp.<pid>.<n>` and removes it again, so the
 * system error names a file that no longer exists by the time it is read.
 */
export async function ensureBoardFile(boardPath: string): Promise<boolean> {
  if ((await readBoard(boardPath)).exists) return false;
  try {
    await saveBoard(boardPath, structuredClone(EMPTY_BOARD));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`cannot create the board ${boardPath}: permission denied`);
    }
    throw error;
  }
  return true;
}

/**
 * The project directory has to exist already.
 *
 * `ensure` writes `docs/product-ops/board.yaml` and `.overlord/console.log`
 * under it, so a mistyped path would otherwise become a new project
 * directory with a console serving it, and the command would exit 0.
 * `console.sh <project>` never created a directory either.
 */
async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
}

/* ----------------------------------------------------------------- server */

/** How the server was started, and how the user stops it again. */
type Started = {
  mode: "cmux" | "detached";
  stop: string;
  detail: string;
};

/** Arguments the server itself is started with. */
function serverArgs(options: Options): string[] {
  const args = [options.boardPath, "--port", String(options.port)];
  if (options.open) args.push("--open");
  return args;
}

/**
 * The line that stops the console on a port.
 *
 * `-sTCP:LISTEN` is not optional: `lsof -ti tcp:<port>` also lists every
 * process *connected* to the port, so the plain form kills the browser that
 * has the console open along with the server.
 */
function killListener(port: number): string {
  return `kill $(lsof -ti tcp:${port} -sTCP:LISTEN)`;
}

/** Quote one argument for the shell line cmux types into the workspace. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start the console in a cmux workspace.
 *
 * `cmux new-workspace --command` runs the line without selecting the
 * workspace, so the user's current workspace stays where it is and the
 * console is one visible workspace they can close themselves.
 *
 * `startTerminal: false` is what keeps that true. cmux reports `tty: null`
 * for a workspace it has just created, and `createWorkspace` would take that
 * as a terminal to start, which selects the new workspace for ~1.2 s and
 * selects the previous one back afterwards -- best-effort, so a failed
 * restore leaves the user in the console's workspace. Nothing here sends
 * input to that terminal: the console is started by `--command` and read
 * over HTTP.
 */
async function startInCmux(options: Options, root: string): Promise<Started> {
  const command = [CONSOLE_SH, ...serverArgs(options)].map(shellQuote).join(" ");
  const created = await cmux.createWorkspace({
    name: `Overlord Console ${basename(root)}`,
    cwd: root,
    command,
    description: options.boardPath,
    startTerminal: false,
  });
  const ref = created.workspaceRef ?? "the new workspace";
  return {
    mode: "cmux",
    stop: `close the cmux workspace ${ref}, or: ${killListener(options.port)}`,
    detail: `cmux workspace ${ref}`,
  };
}

/**
 * Start the console as a detached process.
 *
 * `detached` puts the server in its own process group, so the terminal that
 * ran `ensure` can be closed without taking the console down with it, and its
 * output goes to a log file because there is no terminal to show it in.
 */
async function startDetached(options: Options, root: string): Promise<Started> {
  const logPath = resolve(root, ".overlord/console.log");
  await mkdir(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  try {
    const server = Bun.spawn([process.execPath, SERVER_PATH, ...serverArgs(options)], {
      cwd: root,
      env: { ...process.env },
      detached: true,
      stdout: log,
      stderr: log,
      stdin: "ignore",
    });
    server.unref();
    return {
      mode: "detached",
      stop: `kill ${server.pid}`,
      detail: `detached process ${server.pid}, log: ${logPath}`,
    };
  } finally {
    closeSync(log);
  }
}

/* -------------------------------------------------------------- commander */

/**
 * The calling cmux session, as reported by `cmux identify`. `caller` is
 * absent when the command did not run inside a cmux surface, and that is not
 * an error: it only means there is no session to register.
 */
export function callerSession(identifyJson: string): SessionLink | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(identifyJson);
  } catch {
    return null;
  }
  const caller = (parsed as { caller?: Record<string, unknown> } | null)?.caller;
  if (!caller || typeof caller !== "object") return null;
  const workspaceId =
    typeof caller.workspace_id === "string" ? caller.workspace_id : null;
  const surfaceId =
    typeof caller.surface_id === "string" ? caller.surface_id : null;
  if (!workspaceId && !surfaceId) return null;
  return { workspace_id: workspaceId, surface_id: surfaceId, cwd: null };
}

/** True when two session links point at the same cmux session. */
export function sameSession(
  a: SessionLink | null | undefined,
  b: SessionLink | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    (a.workspace_id ?? null) === (b.workspace_id ?? null) &&
    (a.surface_id ?? null) === (b.surface_id ?? null) &&
    (a.cwd ?? null) === (b.cwd ?? null)
  );
}

/** Working directory cmux reports for a workspace, for the commander record. */
async function workspaceCwd(workspaceId: string | null): Promise<string> {
  if (workspaceId) {
    const workspaces = await cmux.listWorkspaces();
    const found = workspaces.find((entry) => entry.id === workspaceId);
    if (found?.cwd) return found.cwd;
  }
  return process.cwd();
}

/**
 * Write the calling session into `commander`, and report what happened.
 *
 * An unchanged commander is not written back, so a re-run does not touch
 * board.yaml and does not make every open console re-render.
 */
async function registerCommander(boardPath: string): Promise<string> {
  const identify = await cmux.run(["identify", "--json", "--id-format", "both"]);
  if (identify.code !== 0) {
    const detail = (identify.stderr || identify.stdout).trim();
    return `not registered, cmux identify failed: ${detail || `exit ${identify.code}`}`;
  }
  const session = callerSession(identify.stdout);
  if (!session) {
    return "not registered, this command is not running inside a cmux session";
  }
  session.cwd = await workspaceCwd(session.workspace_id ?? null).catch(
    () => process.cwd(),
  );

  const { board } = await readBoard(boardPath);
  if (sameSession(board.commander, session)) {
    return `unchanged, this session is already the commander (surface ${
      session.surface_id ?? "unknown"
    })`;
  }
  await mutateBoard(boardPath, undefined, (current) => {
    current.commander = session;
  });
  return `registered, surface ${session.surface_id ?? "unknown"}`;
}

/**
 * Report the commander line, on every path that gets far enough to have one.
 *
 * The already running path reports it too: a console that is up is a console
 * another session can take over by running `ensure` from there, and the
 * output has to say whether the board was written or was already the same.
 * An unchanged commander is not written back, so the re-run stays a no-op.
 */
async function reportCommander(boardPath: string, cmuxUp: boolean): Promise<void> {
  if (!cmuxUp) {
    report("commander", "not registered, cmux is not reachable");
    report("", "register the session from the console sidebar instead");
    return;
  }
  try {
    report("commander", await registerCommander(boardPath));
  } catch (error) {
    report("commander", `not registered: ${(error as Error).message}`);
    report("", "register the session from the console sidebar instead");
  }
}

/* -------------------------------------------------------------------- CLI */

const USAGE = `usage: console.sh ensure [<project>] [--port <n>] [--open]

Bring up Overlord Console for one project, without starting a second server
and without opening a browser.

arguments:
  <project>           project directory, or a board.yaml inside one
                      (default: the current directory). It has to exist:
                      this command creates the board file, not the project

options:
  --port <n>          port to serve on (default: $OVERLORD_PORT, else 7377)
  --open              also show the console in a cmux browser split
`;

function report(label: string, value: string): void {
  process.stdout.write(`${label ? `${label}:`.padEnd(18) : " ".repeat(18)}${value}\n`);
}

export async function ensure(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const options = parseArgs(argv);
  const root = projectRootFor(options.boardPath);
  const address = `http://127.0.0.1:${options.port}`;

  report("board", options.boardPath);
  report("console", address);

  /* 1b. the project has to exist; this command does not create one. */
  if (!(await isDirectory(root))) {
    process.stderr.write(
      `project directory does not exist: ${root}\n` +
        `create it first, or name one that exists: ` +
        `console.sh ensure <project>\n`,
    );
    return 1;
  }

  /* 2. a console already serving this board is left exactly as it is. */
  const running = await probeConsole(options.port);
  if (running.kind === "console" && running.boardPath === options.boardPath) {
    report("server", "already running, nothing started");
    report("stop", killListener(options.port));
    await reportCommander(options.boardPath, await cmux.available());
    if (options.open) await openInCmux(address);
    return 0;
  }
  if (running.kind === "console") {
    process.stderr.write(
      `port ${options.port} is serving another board: ${running.boardPath}\n` +
        `choose a free port instead of stopping it: ` +
        `console.sh ensure ${shellQuote(root)} --port <port>\n`,
    );
    return 1;
  }
  if (running.kind === "foreign") {
    process.stderr.write(
      `port ${options.port} is held by another process: ${running.detail}\n` +
        `choose a free port instead: ` +
        `console.sh ensure ${shellQuote(root)} --port <port>\n`,
    );
    return 1;
  }

  /* 3. the board has to exist before the server watches its directory. */
  const created = await ensureBoardFile(options.boardPath);
  report("board file", created ? "created" : "already present");

  /* 4. cmux workspace when cmux answers, a detached process otherwise. */
  const cmuxUp = await cmux.available();
  let started: Started;
  if (cmuxUp) {
    try {
      started = await startInCmux(options, root);
    } catch (error) {
      report("cmux", `new-workspace failed: ${(error as Error).message}`);
      report("", "starting the console as a detached process instead");
      started = await startDetached(options, root);
    }
  } else {
    started = await startDetached(options, root);
  }
  report("server", `started, ${started.detail}`);
  report("stop", started.stop);

  if (!(await waitForConsole(options))) {
    process.stderr.write(
      `the console did not answer ${address}/api/state within ` +
        `${READY_TIMEOUT_MS / 1_000}s (${started.detail})\n`,
    );
    return 1;
  }

  /* 5. the commander is a cmux session, so there is none to record without cmux. */
  await reportCommander(options.boardPath, cmuxUp);
  return 0;
}

/**
 * `--open` on an already running console: the server cannot do it any more.
 *
 * No `--workspace` is passed, so the pane may land in the default workspace
 * of `cmux browser open` (`$CMUX_WORKSPACE_ID`, the calling session) rather
 * than in the console's own workspace, which is where the server-side
 * `--open` puts it. Not measured against the running app.
 */
async function openInCmux(address: string): Promise<void> {
  const result = await cmux.run(["browser", "open", address]);
  if (result.code !== 0) {
    report("open", `cmux browser open failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

if (import.meta.main) {
  try {
    process.exit(await ensure(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
