/**
 * `console.sh ensure`.
 *
 * The command exists so that starting Overlord Console is one step that can
 * be repeated safely. The cases covered here are the ones the manual sequence
 * got wrong:
 *   - a server started against a project with no `docs/product-ops` never
 *     established the board watcher (`watchBoard` runs once, at startup), so
 *     board writes only reached the browser through the 15 s poll;
 *   - re-running the launcher on a port already in use failed with
 *     EADDRINUSE and exit code 1;
 *   - an existing board must not be re-initialized by a launcher;
 *   - a missing cmux must not take the console down with it.
 *
 * The cmux binary is replaced by a stub on PATH in every test that touches
 * it. `cmux.ts` resolves `Bun.which("cmux")` ahead of `$CMUX_BIN` and ahead
 * of the `/Applications/cmux.app` fallback, so a stub on PATH is what both
 * the reachable and the unreachable case are built from, and no test can
 * reach the real cmux app.
 *
 * That holds for the subprocess tests through `runEnsure`'s env, and for the
 * tests that call `ensure()` in this process through `PATH_STUB` below: this
 * process's own PATH is pointed at an unreachable stub before any test runs,
 * because `cmux.ts` caches the binary it resolved and would otherwise reach
 * the real cmux app the moment a control-flow change let it get that far.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBoard, mutateBoard, saveBoard, type Board } from "./board.ts";
import * as cmux from "./cmux.ts";
import {
  callerSession,
  ensure,
  ensureBoardFile,
  parseArgs,
  probeConsole,
  sameSession,
  shellQuote,
} from "./ensure.ts";

const temporaries: string[] = [];
const startedPorts: number[] = [];
const startedPids: number[] = [];

/**
 * PATH for this process, for the tests that run `ensure()` in-process.
 *
 * `cmux.ts` keeps the binary it first resolved for the life of the process
 * and looks at PATH before `$CMUX_BIN`, so this is set once, before any test
 * runs, and every in-process cmux call from then on lands on a stub that
 * exits 127. Without it an in-process `ensure()` that got past its early
 * return would create a workspace in the developer's own cmux app.
 */
const PATH_STUB = mkdtempSync(join(tmpdir(), "overlord-ensure-path-"));
temporaries.push(PATH_STUB);
writeFileSync(
  join(PATH_STUB, "cmux"),
  ['#!/bin/sh', 'echo "cmux: command not found" >&2', "exit 127", ""].join("\n"),
  "utf8",
);
chmodSync(join(PATH_STUB, "cmux"), 0o755);
process.env.PATH = `${PATH_STUB}:${process.env.PATH ?? ""}`;

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overlord-ensure-"));
  temporaries.push(dir);
  return dir;
}

/** A port nothing is listening on, taken and released by the kernel. */
async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port!;
  server.stop(true);
  return port;
}

/**
 * Stop whatever console this test file started on a port.
 *
 * `-sTCP:LISTEN` is what makes this safe: `lsof -ti tcp:<port>` also reports
 * the processes *connected* to the port, which includes this test process
 * while it holds an SSE stream open, and killing that ends the test run.
 */
async function listeningPids(port: number): Promise<number[]> {
  const listeners = Bun.spawn(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  return (await new Response(listeners.stdout).text())
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function stopPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function stopConsole(port: number): Promise<void> {
  for (const pid of await listeningPids(port)) stopPid(pid);
}

afterAll(async () => {
  // A pid is the exact process this file started. A port is only the process
  // that holds it now, which after an ephemeral port is released can be an
  // unrelated one, so it is the fallback for servers whose pid never reached
  // this file.
  for (const pid of startedPids) stopPid(pid);
  for (const port of startedPorts) await stopConsole(port);
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

/** Run something with both streams captured, so a command stays quiet. */
async function capture(
  body: () => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const streams = [process.stdout, process.stderr] as const;
  const originals = streams.map((stream) => stream.write.bind(stream));
  const captured = ["", ""];
  streams.forEach((stream, index) => {
    stream.write = ((chunk: string) => {
      captured[index] += chunk;
      return true;
    }) as typeof stream.write;
  });
  try {
    const code = await body();
    return { code, stdout: captured[0]!, stderr: captured[1]! };
  } finally {
    streams.forEach((stream, index) => {
      stream.write = originals[index]!;
    });
  }
}

/* ------------------------------------------------------------ cmux stubs */

const TREE_JSON = JSON.stringify({
  windows: [
    {
      ref: "window:1",
      id: "0BE47E1C-0000-4000-8000-000000000001",
      workspaces: [
        {
          ref: "workspace:99",
          id: "0BE47E1C-0000-4000-8000-000000000002",
          title: "Overlord Console",
          index: 99,
          selected: false,
          panes: [
            {
              surfaces: [
                {
                  ref: "surface:99",
                  id: "0BE47E1C-0000-4000-8000-000000000003",
                  title: "console",
                  type: "terminal",
                  // What the real cmux reports for a workspace it has just
                  // created, `--command` or not: the terminal process has no
                  // tty yet. `createWorkspace` must still not select the
                  // workspace to give it one.
                  tty: null,
                  url: null,
                  selected: true,
                  focused: false,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const IDENTIFY_JSON = JSON.stringify({
  caller: {
    workspace_id: "0BE47E1C-0000-4000-8000-000000000002",
    surface_id: "0BE47E1C-0000-4000-8000-000000000004",
    surface_ref: "surface:30",
  },
});

/**
 * A directory to put in front of PATH, holding a `cmux` that behaves the way
 * one test needs it to.
 *
 * `reachable: false` is a `cmux` that exits 127 the way a missing binary
 * does. It has to exist as a file, because that is what makes `cmux.ts` stop
 * looking and never fall back to `/Applications/cmux.app`.
 *
 * The reachable stub runs `--command` in the background with its output in a
 * file, which is what actually starts the console server; inheriting the
 * stub's stdout pipe instead would hold `cmux.run` open until the server
 * exited.
 */
async function cmuxStub(options: {
  reachable: boolean;
  callLog: string;
  serverLog?: string;
}): Promise<string> {
  const dir = await scratch();
  const script = join(dir, "cmux");
  const body = options.reachable
    ? [
        "#!/bin/sh",
        `echo "$*" >> ${shellQuote(options.callLog)}`,
        'case "$1" in',
        "  ping) echo PONG; exit 0;;",
        `  identify) cat <<'JSON'`,
        IDENTIFY_JSON,
        "JSON",
        "    exit 0;;",
        `  tree) cat <<'JSON'`,
        TREE_JSON,
        "JSON",
        "    exit 0;;",
        '  workspace) [ "$2" = "list" ] && { echo \'{"workspaces":[]}\'; exit 0; }; exit 1;;',
        "  new-workspace)",
        '    command=""',
        "    while [ $# -gt 0 ]; do",
        '      [ "$1" = "--command" ] && command="$2"',
        "      shift",
        "    done",
        `    sh -c "$command" >> ${shellQuote(options.serverLog ?? "/dev/null")} 2>&1 &`,
        "    echo OK workspace:99",
        "    exit 0;;",
        "esac",
        'echo "stub cmux: unexpected call: $*" >&2',
        "exit 1",
        "",
      ]
    : [
        "#!/bin/sh",
        `echo "$*" >> ${shellQuote(options.callLog)}`,
        'echo "cmux: command not found" >&2',
        "exit 127",
        "",
      ];
  writeFileSync(script, body.join("\n"), "utf8");
  chmodSync(script, 0o755);
  return dir;
}

/** Run the `ensure` CLI as a subprocess, with a stubbed cmux in front. */
async function runEnsure(
  args: string[],
  stubDir: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "ensure.ts"), ...args], {
    cwd,
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** Read `/api/state` from a running console. */
async function state(port: number): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Wait for one `board` frame on the SSE stream, and report how long it took.
 * `null` means the frame did not arrive inside `timeoutMs`.
 */
async function waitForBoardFrame(
  port: number,
  trigger: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<number | null> {
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
    signal: AbortSignal.timeout(timeoutMs + 2_000),
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  // The server writes ": connected" as soon as the stream opens; the trigger
  // waits for it so the write cannot land before the watcher has a listener.
  await reader.read();
  const startedAt = Date.now();
  await trigger();
  try {
    for (;;) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return null;
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => null),
      ]);
      if (!chunk || chunk.done) return null;
      if (decoder.decode(chunk.value).includes('"type":"board"')) {
        return Date.now() - startedAt;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/* -------------------------------------------------------------- parseArgs */

describe("parseArgs", () => {
  test("takes the same words in the same places as the server", () => {
    const options = parseArgs(["/tmp/project", "--port", "7401", "--open"]);
    expect(options.boardPath).toBe("/tmp/project/docs/product-ops/board.yaml");
    expect(options.port).toBe(7401);
    expect(options.open).toBe(true);
  });

  test("accepts a board file directly, and defaults to no browser", () => {
    const options = parseArgs(["--board", "/tmp/other/board.yaml"]);
    expect(options.boardPath).toBe("/tmp/other/board.yaml");
    expect(options.open).toBe(false);
  });

  test("defaults the port to 7377", () => {
    expect(parseArgs(["/tmp/project"]).port).toBe(7377);
  });

  test("rejects a port that is not a port", () => {
    expect(() => parseArgs(["--port", "no"])).toThrow("invalid port");
    expect(() => parseArgs(["--port", "70000"])).toThrow("invalid port");
  });

  test("rejects a mistyped option instead of taking its value as the project", () => {
    // `--prot 7420` used to be dropped silently, leaving `7420` as the
    // positional argument and `./7420` as the project.
    expect(() => parseArgs(["--prot", "7420"])).toThrow("unknown option: --prot");
    expect(() => parseArgs(["--opne"])).toThrow("unknown option: --opne");
    expect(() => parseArgs(["-p", "7420"])).toThrow("unknown option: -p");
  });

  test("still parses a help line rather than throwing on it", () => {
    expect(parseArgs(["--help"]).port).toBe(7377);
    expect(parseArgs(["-h"]).port).toBe(7377);
  });
});

/* --------------------------------------------------------- cmux isolation */

describe("in-process cmux", () => {
  test("resolves to the stub on PATH, never to the real cmux app", async () => {
    expect(Bun.which("cmux", { PATH: process.env.PATH! })).toBe(join(PATH_STUB, "cmux"));
    // The stub is what actually ran: it exits 127 with the shell's own
    // wording, where an unresolved binary would never be spawned and
    // `cmux.run` would answer with its own "cmux CLI not found".
    const result = await cmux.run(["ping"]);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("cmux: command not found");
    expect(result.stderr).not.toContain("cmux CLI not found");
    // This call also fixes `cmux.ts`'s cached binary to the stub for the rest
    // of the run, which is what keeps `ensure()` in this process away from
    // the developer's cmux app whatever the control flow does.
    expect(await cmux.available()).toBe(false);
  });
});

describe("shellQuote", () => {
  test("leaves an ordinary path alone and quotes the rest", () => {
    expect(shellQuote("/tmp/a-b/c.yaml")).toBe("/tmp/a-b/c.yaml");
    expect(shellQuote("/tmp/my project")).toBe("'/tmp/my project'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

/* ------------------------------------------------------------ commander */

describe("callerSession", () => {
  test("reads the calling session out of cmux identify", () => {
    expect(callerSession(IDENTIFY_JSON)).toEqual({
      workspace_id: "0BE47E1C-0000-4000-8000-000000000002",
      surface_id: "0BE47E1C-0000-4000-8000-000000000004",
      cwd: null,
    });
  });

  test("reports no session rather than throwing", () => {
    expect(callerSession("not json")).toBeNull();
    expect(callerSession("{}")).toBeNull();
    expect(
      callerSession(JSON.stringify({ caller: { workspace_id: null, surface_id: null } })),
    ).toBeNull();
  });
});

describe("sameSession", () => {
  const session = { workspace_id: "w", surface_id: "s", cwd: "/tmp" };

  test("compares the three identifying fields", () => {
    expect(sameSession(session, { ...session })).toBe(true);
    expect(sameSession(session, { ...session, surface_id: "other" })).toBe(false);
    expect(sameSession(session, { ...session, cwd: "/other" })).toBe(false);
    expect(sameSession(null, null)).toBe(true);
    expect(sameSession(null, session)).toBe(false);
  });
});

/* ---------------------------------------------------------------- probe */

describe("probeConsole", () => {
  test("reports an unused port as absent", async () => {
    expect(await probeConsole(await freePort())).toEqual({ kind: "absent" });
  });

  test("reports the board a console on the port is serving", async () => {
    const boardPath = "/tmp/some-project/docs/product-ops/board.yaml";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ boardPath }),
    });
    try {
      expect(await probeConsole(server.port!)).toEqual({ kind: "console", boardPath });
    } finally {
      server.stop(true);
    }
  });

  test("reports a port held by something else as foreign", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not the console"),
    });
    try {
      const probe = await probeConsole(server.port!);
      expect(probe.kind).toBe("foreign");
    } finally {
      server.stop(true);
    }
  });
});

/* ----------------------------------------------------------- board file */

describe("ensureBoardFile", () => {
  test("creates the skeleton board and its directory", async () => {
    const root = await scratch();
    const boardPath = join(root, "docs/product-ops/board.yaml");
    expect(await ensureBoardFile(boardPath)).toBe(true);
    expect(existsSync(boardPath)).toBe(true);

    const { board, exists } = await loadBoard(boardPath);
    expect(exists).toBe(true);
    expect(board.version).toBe(1);
    expect(board.items).toEqual([]);
    expect(typeof board.updated_at).toBe("string");
  });

  test("leaves an existing board byte for byte alone", async () => {
    const root = await scratch();
    const boardPath = join(root, "docs/product-ops/board.yaml");
    const board: Board = {
      version: 1,
      updated_at: "2026-08-01T00:00:00Z",
      items: [{ id: "OV-1", title: "Keep me", state: "inbox" }],
    };
    await saveBoard(boardPath, board);
    const before = readFileSync(boardPath, "utf8");

    expect(await ensureBoardFile(boardPath)).toBe(false);
    expect(readFileSync(boardPath, "utf8")).toBe(before);
  });
});

/* ------------------------------------------------------- occupied port */

describe("ensure on an occupied port", () => {
  test("refuses to move to another port when another board is served", async () => {
    const other = "/tmp/another-project/docs/product-ops/board.yaml";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ boardPath: other }),
    });
    const root = await scratch();
    try {
      const { code, stdout, stderr } = await capture(() =>
        ensure([root, "--port", String(server.port)]),
      );
      expect(code).toBe(1);
      expect(stderr).toContain(other);
      expect(stderr).toContain("--port");
      // Nothing was started and nothing was created.
      expect(stdout).not.toContain("started");
      expect(existsSync(join(root, "docs/product-ops/board.yaml"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a port held by a process that is not a console", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not the console"),
    });
    const root = await scratch();
    try {
      const { code, stderr } = await capture(() =>
        ensure([root, "--port", String(server.port)]),
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--port");
      expect(existsSync(join(root, "docs/product-ops/board.yaml"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

/* -------------------------------------------------- missing project root */

describe("ensure on a directory that does not exist", () => {
  test("fails without creating the project, the board or a server", async () => {
    const missing = join(await scratch(), "typo-project");
    const port = await freePort();

    const { code, stdout, stderr } = await capture(() =>
      ensure([missing, "--port", String(port)]),
    );

    expect(code).toBe(1);
    expect(stderr).toContain(missing);
    expect(stderr).toContain("does not exist");
    // Nothing under the mistyped path, and no server on the port.
    expect(existsSync(missing)).toBe(false);
    expect(stdout).not.toContain("started");
    expect(await probeConsole(port)).toEqual({ kind: "absent" });
  });
});

/* --------------------------------------------------------------- no cmux */

describe("ensure without cmux", () => {
  test(
    "creates the board, serves it with a live watcher, and repeats cleanly",
    async () => {
      const root = await scratch();
      const boardPath = join(root, "docs/product-ops/board.yaml");
      const callLog = join(await scratch(), "cmux-calls.log");
      const stub = await cmuxStub({ reachable: false, callLog });
      const port = await freePort();
      startedPorts.push(port);

      const first = await runEnsure([root, "--port", String(port)], stub, root);
      expect(first.stderr).toBe("");
      expect(first.code).toBe(0);

      // The board is created before the server starts, which is what makes
      // the watcher establish.
      expect(existsSync(boardPath)).toBe(true);
      expect(first.stdout).toContain("board file:       created");

      // The URL and the way to stop the server are both in the output, and
      // no browser was opened.
      expect(first.stdout).toContain(`http://127.0.0.1:${port}`);
      expect(first.stdout).toMatch(/\nstop: +kill \d+\n/);
      expect(readFileSync(callLog, "utf8")).not.toContain("browser open");

      // A failing cmux is reported, not fatal.
      expect(first.stdout).toContain("commander:        not registered, cmux is not reachable");
      expect(first.stdout).toContain("register the session from the console sidebar instead");

      const served = await state(port);
      expect(served.exists).toBe(true);
      expect(served.boardPath).toBe(boardPath);
      expect((served.cmux as { available: boolean }).available).toBe(false);
      expect(served.board).toEqual({ version: 1, updated_at: expect.any(String), items: [] });

      const log = readFileSync(join(root, ".overlord/console.log"), "utf8");
      expect(log).toContain("Overlord Console");
      expect(log).not.toContain("board watch unavailable");

      // An external write reaches the browser over SSE, not through the
      // frontend's 15 s poll.
      const elapsed = await waitForBoardFrame(port, async () => {
        await saveBoard(boardPath, {
          version: 1,
          updated_at: null,
          items: [{ id: "OV-1", title: "written outside the console", state: "inbox" }],
        });
      });
      expect(elapsed).not.toBeNull();
      expect(elapsed!).toBeLessThan(5_000);

      // Running it again starts nothing: same listener, no EADDRINUSE.
      // From here the server is tracked by pid: the port alone would let a
      // later cleanup kill whatever process the kernel handed the port to.
      const pid = Number(first.stdout.match(/detached process (\d+)/)![1]);
      startedPids.push(pid);
      startedPorts.splice(startedPorts.indexOf(port), 1);
      const second = await runEnsure([root, "--port", String(port)], stub, root);
      expect(second.code).toBe(0);
      expect(second.stderr).toBe("");
      expect(second.stdout).toContain("server:           already running, nothing started");
      expect(second.stdout).not.toContain("started, detached process");
      expect(second.stdout).toContain(`http://127.0.0.1:${port}`);
      expect(second.stdout).toContain("stop:");
      // The original server is the only one listening: no second process.
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(await listeningPids(port)).toEqual([pid]);
      expect((await state(port)).boardPath).toBe(boardPath);

      stopPid(pid);
    },
    60_000,
  );
});

/* ------------------------------------------------------------ with cmux */

describe("ensure with cmux", () => {
  test(
    "starts the console in a cmux workspace and records the commander",
    async () => {
      const root = await scratch();
      const boardPath = join(root, "docs/product-ops/board.yaml");
      const existing: Board = {
        version: 1,
        updated_at: "2026-08-01T00:00:00Z",
        items: [
          { id: "OV-1", title: "First", state: "inbox" },
          { id: "OV-2", title: "Second", state: "specified", owner: "issei" },
        ],
      };
      await saveBoard(boardPath, existing);
      const itemsBefore = (await loadBoard(boardPath)).board.items;

      const logDir = await scratch();
      const callLog = join(logDir, "cmux-calls.log");
      const serverLog = join(logDir, "console.log");
      const stub = await cmuxStub({ reachable: true, callLog, serverLog });
      const port = await freePort();
      startedPorts.push(port);

      const result = await runEnsure([root, "--port", String(port)], stub, root);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("board file:       already present");
      expect(result.stdout).toContain("cmux workspace workspace:99");
      expect(result.stdout).toContain(`http://127.0.0.1:${port}`);
      expect(result.stdout).toContain("close the cmux workspace workspace:99");
      expect(result.stdout).toContain("commander:        registered");

      // The console runs, and no browser was opened on the way.
      expect((await state(port)).boardPath).toBe(boardPath);
      const calls = readFileSync(callLog, "utf8");
      expect(calls).toContain("new-workspace");
      expect(calls).not.toContain("browser open");
      // The workspace was never selected: the terminal already had a tty.
      expect(calls).not.toContain("select-workspace");

      // The existing board kept its items, and only gained the commander.
      const after = await loadBoard(boardPath);
      expect(after.board.items).toEqual(itemsBefore);
      expect(after.board.commander).toEqual({
        workspace_id: "0BE47E1C-0000-4000-8000-000000000002",
        surface_id: "0BE47E1C-0000-4000-8000-000000000004",
        cwd: expect.any(String),
      });

      // The watcher established, because the board existed before the start.
      expect(readFileSync(serverLog, "utf8")).not.toContain("board watch unavailable");

      // A second run against the console that is now up starts nothing and
      // says the commander is the one already on the board.
      const again = await runEnsure([root, "--port", String(port)], stub, root);
      expect(again.stderr).toBe("");
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("server:           already running, nothing started");
      expect(again.stdout).toContain("commander:        unchanged, this session is already");
      expect(readFileSync(callLog, "utf8")).not.toContain("select-workspace");

      // A different session running `ensure` takes an already running console
      // over: the early return used to skip the registration entirely.
      await mutateBoard(boardPath, undefined, (current) => {
        current.commander = {
          workspace_id: "0BE47E1C-0000-4000-8000-00000000000A",
          surface_id: "0BE47E1C-0000-4000-8000-00000000000B",
          cwd: "/tmp/elsewhere",
        };
      });
      const takeover = await runEnsure([root, "--port", String(port)], stub, root);
      expect(takeover.stderr).toBe("");
      expect(takeover.code).toBe(0);
      expect(takeover.stdout).toContain("server:           already running, nothing started");
      expect(takeover.stdout).toContain(
        "commander:        registered, surface 0BE47E1C-0000-4000-8000-000000000004",
      );
      expect(takeover.stdout).not.toContain("started, cmux workspace");
      expect((await loadBoard(boardPath)).board.commander).toEqual({
        workspace_id: "0BE47E1C-0000-4000-8000-000000000002",
        surface_id: "0BE47E1C-0000-4000-8000-000000000004",
        cwd: expect.any(String),
      });
      // Taking over did not touch the items either.
      expect((await loadBoard(boardPath)).board.items).toEqual(itemsBefore);

      await stopConsole(port);
    },
    60_000,
  );
});
