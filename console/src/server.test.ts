/**
 * The console server's HTTP surface.
 *
 * `POST /api/items` covers what OV-109-C1 changes: the create dialog no longer
 * asks for a `project`, so the two things it used to decide are decided here
 * instead.
 *   - the new card's id prefix came from the request's `project`, which put
 *     `OVER-111` on a board whose other cards were all `OV-`;
 *   - `project` itself was whatever the dialog's optional field held.
 *
 * `PATCH /api/items/:id` covers what OV-105-C2 adds: a card that moves into
 * `done` is delivered in the background and the run reports itself over
 * `/api/events`.
 *
 * The server is a script that starts listening on import, so every case runs
 * it as a real process against a throwaway board and speaks HTTP to it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBoard, saveBoard, type Board, type Item } from "./board.ts";

const serverPath = join(import.meta.dir, "server.ts");
const temporaries: string[] = [];

afterAll(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overlord-server-"));
  temporaries.push(dir);
  return dir;
}

function item(id: string, project: string | null): Item {
  return { id, project, title: id, state: "inbox" };
}

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

type RunningServer = {
  base: string;
  boardPath: string;
  stop: () => Promise<void>;
};

type ServerSetup = {
  /** Board file to serve; a file inside a throwaway directory by default. */
  boardPath?: string;
  /** Extra command line arguments, after `--board` and `--port`. */
  args?: string[];
  /** Executable name -> shell script, put on the PATH ahead of everything. */
  stubs?: Record<string, string>;
  /** Extra environment for the server process. */
  env?: Record<string, string>;
};

/** Every external command the server may reach, refusing to run by default. */
const REFUSING_STUB = "#!/bin/sh\nexit 1\n";

/**
 * Start the console server on a throwaway board.
 *
 * `cmux` and `gh` are stubbed to scripts that fail, and CMUX_SOCK points at a
 * path that does not exist, so a test process never reaches the cmux app the
 * user is running and never talks to GitHub. A case that needs `gh` to answer
 * replaces the stub through `setup.stubs`; the stub directory is always first
 * on the PATH of the server process, which is the environment `change.ts`
 * hands to `Bun.spawn`.
 */
async function startServer(
  items: Item[],
  setup: ServerSetup = {},
): Promise<RunningServer> {
  const dir = await scratch();
  const boardPath = setup.boardPath ?? join(dir, "board.yaml");
  const board: Board = { version: 1, updated_at: null, items };
  await saveBoard(boardPath, board);

  const scripts: Record<string, string> = {
    cmux: REFUSING_STUB,
    gh: REFUSING_STUB,
    ...setup.stubs,
  };
  for (const [name, script] of Object.entries(scripts)) {
    const path = join(dir, name);
    await writeFile(path, script, "utf8");
    chmodSync(path, 0o755);
  }

  const port = await freePort();
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      serverPath,
      "--board",
      boardPath,
      "--port",
      String(port),
      ...(setup.args ?? []),
    ],
    {
      env: {
        ...process.env,
        ...setup.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        CMUX_BIN: join(dir, "cmux"),
        CMUX_SOCK: join(dir, "absent.sock"),
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    proc.kill("SIGKILL");
    await proc.exited;
  };

  const deadline = Date.now() + 15_000;
  for (;;) {
    const reached = await fetch(`${base}/api/state`).catch(() => null);
    if (reached?.ok) break;
    if (Date.now() >= deadline) {
      await stop();
      throw new Error(`server did not start on ${base}`);
    }
    await Bun.sleep(50);
  }
  return { base, boardPath, stop };
}

/** POST one card and return the item the server answered with. */
async function createCard(
  base: string,
  payload: Record<string, unknown>,
): Promise<Item> {
  const response = await fetch(`${base}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { item: Item }).item;
}

describe("POST /api/items", () => {
  test("ids a card on an empty board with the OV- prefix", async () => {
    const server = await startServer([]);
    try {
      const created = await createCard(server.base, { title: "t", evidence: "e" });
      expect(created.id.startsWith("OV-")).toBe(true);
      expect(created.project).toBe(null);
      expect(created.evidence).toBe("e");

      const { board } = await loadBoard(server.boardPath);
      expect(board.items[0]!.id).toBe(created.id);
    } finally {
      await server.stop();
    }
  });

  test("takes the board's project when the board names exactly one", async () => {
    const server = await startServer([
      item("OV-100", "Overlord"),
      item("OV-101", "Overlord"),
      item("OV-102", null),
    ]);
    try {
      const created = await createCard(server.base, { title: "t", evidence: "e" });
      expect(created.project).toBe("Overlord");
      expect(created.id).toBe("OV-103");
    } finally {
      await server.stop();
    }
  });

  test("leaves project null when the board names more than one", async () => {
    const server = await startServer([
      item("OV-100", "Overlord"),
      item("OV-101", "Console"),
    ]);
    try {
      const created = await createCard(server.base, { title: "t", evidence: "e" });
      expect(created.project).toBe(null);
      // The prefix follows the board, not any project name on it.
      expect(created.id).toBe("OV-102");
    } finally {
      await server.stop();
    }
  });

  test("ignores a project sent by a caller", async () => {
    const server = await startServer([item("OV-100", "Overlord")]);
    try {
      const created = await createCard(server.base, {
        title: "t",
        evidence: "e",
        project: "Something Else",
      });
      expect(created.project).toBe("Overlord");
      expect(created.id).toBe("OV-101");
    } finally {
      await server.stop();
    }
  });
});

/* ---------------------------------------------------------------- deliver */

/** Run one git command, raising its own diagnostics on failure. */
async function git(args: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} exited with ${code}: ${stderr}`);
  }
}

type Project = {
  /** Working checkout, on the branch to deliver. */
  root: string;
  /** Board file inside that checkout. */
  boardPath: string;
  /** Bare repository the checkout pushes to. */
  remote: string;
};

/**
 * A repository whose `origin` is a bare repository on this machine.
 *
 * The delivery pushes for real, so `origin` has to exist; a bare repository
 * next to the checkout keeps that push local and the test offline. The
 * checkout is left on `work`, which is what the delivery takes as its head,
 * one commit ahead of `main`, which `origin/HEAD` names so that the base is
 * resolved without asking `gh`.
 */
async function deliveryProject(): Promise<Project> {
  const dir = await scratch();
  const remote = join(dir, "remote.git");
  const root = join(dir, "project");

  await git(["init", "--bare", "--initial-branch=main", remote]);
  await git(["init", "--initial-branch=main", root]);
  await git(["config", "user.email", "test@example.invalid"], root);
  await git(["config", "user.name", "Overlord Test"], root);
  await git(["config", "commit.gpgsign", "false"], root);

  await writeFile(join(root, "README.md"), "base\n", "utf8");
  await git(["add", "-A"], root);
  await git(["commit", "-m", "base"], root);
  await git(["remote", "add", "origin", remote], root);
  await git(["push", "-u", "origin", "main"], root);
  await git(["remote", "set-head", "origin", "main"], root);

  await git(["checkout", "-b", "work"], root);
  await writeFile(join(root, "work.txt"), "work\n", "utf8");
  await git(["add", "-A"], root);
  await git(["commit", "-m", "work"], root);

  return { root, boardPath: join(root, "board.yaml"), remote };
}

/**
 * A `gh` that answers the delivery without a network.
 *
 * Every call appends `<subcommand> <second argument>` to $GH_LOG, so a case
 * can count what the delivery actually ran. `pr create` optionally waits, to
 * hold one delivery open while the next request is made, and optionally
 * fails, to produce a delivery that changes nothing.
 */
function ghStub(setup: { sleepSeconds?: number; failCreate?: boolean } = {}): string {
  const wait = setup.sleepSeconds ? `    sleep ${setup.sleepSeconds}\n` : "";
  const fail = setup.failCreate
    ? '    echo "gh: pull request refused" >&2\n    exit 1\n'
    : "";
  const view =
    '{"number":41,"url":"https://example.invalid/pull/41","state":"OPEN",' +
    '"headRefOid":"1111111111111111111111111111111111111111",' +
    '"headRefName":"work","baseRefName":"main"}';
  return [
    "#!/bin/sh",
    'printf \'%s %s\\n\' "$1" "$2" >> "$GH_LOG"',
    'case "$1 $2" in',
    '  "pr list") echo "[]" ;;',
    '  "pr create")',
    wait + fail + '    echo "https://example.invalid/pull/41"',
    "    ;;",
    `  "pr view") echo '${view}' ;;`,
    '  *) echo "{}" ;;',
    "esac",
    "",
  ].join("\n");
}

/** The `gh` calls the server made, as `<subcommand> <second argument>`. */
async function ghCalls(logPath: string): Promise<string[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "");
}

type DeliveryFrame = {
  type: string;
  card: string;
  status: string;
  reason?: string;
  pr?: { number?: number; url?: string | null };
  unmerged?: string[];
  warnings?: string[];
};

type EventStream = {
  /** Every frame received so far, in order. */
  frames: DeliveryFrame[];
  deliveries: () => DeliveryFrame[];
  waitForDelivery: (
    accept: (frame: DeliveryFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<DeliveryFrame>;
  close: () => void;
};

/** Subscribe to `/api/events` and collect the frames as they arrive. */
async function openEvents(base: string): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const frames: DeliveryFrame[] = [];

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          for (const line of buffer.slice(0, boundary).split("\n")) {
            if (!line.startsWith("data: ")) continue;
            frames.push(JSON.parse(line.slice(6)) as DeliveryFrame);
          }
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      /* closed with the server or by close() */
    }
  })();

  const deliveries = () => frames.filter((frame) => frame.type === "delivery");
  return {
    frames,
    deliveries,
    async waitForDelivery(accept, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = deliveries().find(accept);
        if (found) return found;
        if (Date.now() >= deadline) {
          throw new Error(
            `no matching delivery frame within ${timeoutMs}ms: ` +
              JSON.stringify(deliveries()),
          );
        }
        await Bun.sleep(25);
      }
    },
    close: () => controller.abort(),
  };
}

/** PATCH one card without an optimistic revision. */
function patchCard(
  base: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/api/items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patch }),
  });
}

function card(state: Item["state"]): Item {
  return { id: "OV-1", project: "Overlord", title: "delivery card", state };
}

describe("PATCH /api/items/:id delivery", () => {
  test("delivers a card that moves into done, and reports it over SSE", async () => {
    const project = await deliveryProject();
    const logPath = join(project.root, "gh.log");
    const server = await startServer([card("acceptance")], {
      boardPath: project.boardPath,
      stubs: { gh: ghStub({ sleepSeconds: 2 }) },
      env: { GH_LOG: logPath },
    });
    const events = await openEvents(server.base);
    try {
      const started = Date.now();
      const response = await patchCard(server.base, "OV-1", { state: "done" });
      const elapsed = Date.now() - started;
      expect(response.status).toBe(200);

      // The request did not wait for the delivery: `gh pr create` sleeps two
      // seconds, and the answer came back before it could have finished with
      // no outcome frame received yet.
      expect(elapsed).toBeLessThan(2_000);
      expect(events.deliveries().filter((frame) => frame.status !== "running")).toEqual([]);
      await events.waitForDelivery((frame) => frame.status === "running", 5_000);

      const outcome = await events.waitForDelivery(
        (frame) => frame.status !== "running",
      );
      expect(outcome).toMatchObject({
        type: "delivery",
        card: "OV-1",
        status: "created",
      });
      expect(outcome.pr?.number).toBe(41);
      expect(outcome.pr?.url).toBe("https://example.invalid/pull/41");
      expect(Array.isArray(outcome.warnings)).toBe(true);

      expect((await ghCalls(logPath)).filter((c) => c === "pr create")).toHaveLength(1);

      // The branch really was pushed, and the delivery is on the board.
      await git(["rev-parse", "--verify", "refs/heads/work"], project.remote);
      const { board } = await loadBoard(project.boardPath);
      expect(board.items[0]!.state).toBe("done");
      expect(board.items[0]!.delivery).toMatchObject({
        branch: "work",
        base: "main",
        pr: { number: 41 },
      });
    } finally {
      events.close();
      await server.stop();
    }
  });

  test("does not deliver again when a done card is patched again", async () => {
    const project = await deliveryProject();
    const logPath = join(project.root, "gh.log");
    const server = await startServer([card("acceptance")], {
      boardPath: project.boardPath,
      stubs: { gh: ghStub() },
      env: { GH_LOG: logPath },
    });
    const events = await openEvents(server.base);
    try {
      expect((await patchCard(server.base, "OV-1", { state: "done" })).status).toBe(200);
      await events.waitForDelivery((frame) => frame.status === "created");

      const again = await patchCard(server.base, "OV-1", {
        state: "done",
        owner: "someone",
      });
      expect(again.status).toBe(200);
      await Bun.sleep(750);

      expect(events.deliveries().map((frame) => frame.status)).toEqual([
        "running",
        "created",
      ]);
      expect((await ghCalls(logPath)).filter((c) => c === "pr create")).toHaveLength(1);
      // The second PATCH still wrote the board.
      const { board } = await loadBoard(project.boardPath);
      expect(board.items[0]!.owner).toBe("someone");
    } finally {
      events.close();
      await server.stop();
    }
  });

  test("delivers nothing for a transition to a state other than done", async () => {
    const project = await deliveryProject();
    const logPath = join(project.root, "gh.log");
    const server = await startServer([card("implementing")], {
      boardPath: project.boardPath,
      stubs: { gh: ghStub() },
      env: { GH_LOG: logPath },
    });
    const events = await openEvents(server.base);
    try {
      for (const state of ["reviewing", "acceptance", "blocked"]) {
        expect((await patchCard(server.base, "OV-1", { state })).status).toBe(200);
      }
      await Bun.sleep(750);
      expect(events.deliveries()).toEqual([]);
      expect(await ghCalls(logPath)).toEqual([]);
    } finally {
      events.close();
      await server.stop();
    }
  });

  test("keeps the card done and reports the failure when the delivery fails", async () => {
    const project = await deliveryProject();
    const logPath = join(project.root, "gh.log");
    const server = await startServer([card("acceptance")], {
      boardPath: project.boardPath,
      stubs: { gh: ghStub({ failCreate: true }) },
      env: { GH_LOG: logPath },
    });
    const events = await openEvents(server.base);
    try {
      expect((await patchCard(server.base, "OV-1", { state: "done" })).status).toBe(200);
      const outcome = await events.waitForDelivery(
        (frame) => frame.status !== "running",
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.reason ?? "").toContain("gh pr create failed");

      const { board } = await loadBoard(project.boardPath);
      expect(board.items[0]!.state).toBe("done");
      expect(board.items[0]!.delivery ?? null).toBe(null);
    } finally {
      events.close();
      await server.stop();
    }
  });

  test("runs one delivery for a card moved into done twice in a row", async () => {
    const project = await deliveryProject();
    const logPath = join(project.root, "gh.log");
    const server = await startServer([card("acceptance")], {
      boardPath: project.boardPath,
      stubs: { gh: ghStub({ sleepSeconds: 2 }) },
      env: { GH_LOG: logPath },
    });
    const events = await openEvents(server.base);
    try {
      // Two transitions into done while the first delivery is still running.
      expect((await patchCard(server.base, "OV-1", { state: "done" })).status).toBe(200);
      expect((await patchCard(server.base, "OV-1", { state: "acceptance" })).status).toBe(200);
      expect((await patchCard(server.base, "OV-1", { state: "done" })).status).toBe(200);

      await events.waitForDelivery((frame) => frame.status === "created");
      await Bun.sleep(750);

      // Both transitions are answered, one delivery ran.
      const statuses = events.deliveries().map((frame) => frame.status);
      expect(statuses.filter((status) => status === "running")).toHaveLength(2);
      expect(statuses.filter((status) => status !== "running")).toEqual(["created"]);
      expect((await ghCalls(logPath)).filter((c) => c === "pr create")).toHaveLength(1);
    } finally {
      events.close();
      await server.stop();
    }
  });

  test("skips quietly when the project has no remote to deliver to", async () => {
    const project = await deliveryProject();
    await git(["remote", "remove", "origin"], project.root);
    const logPath = join(project.root, "gh.log");
    const server = await startServer([card("acceptance")], {
      boardPath: project.boardPath,
      stubs: { gh: ghStub() },
      env: { GH_LOG: logPath },
    });
    const events = await openEvents(server.base);
    try {
      expect((await patchCard(server.base, "OV-1", { state: "done" })).status).toBe(200);
      const outcome = await events.waitForDelivery(
        (frame) => frame.status !== "running",
      );
      expect(outcome).toMatchObject({ status: "skipped", reason: "no-remote" });
      expect(await ghCalls(logPath)).toEqual([]);
    } finally {
      events.close();
      await server.stop();
    }
  });

  test("skips quietly when the board is not inside a git repository", async () => {
    const server = await startServer([card("acceptance")]);
    const events = await openEvents(server.base);
    try {
      expect((await patchCard(server.base, "OV-1", { state: "done" })).status).toBe(200);
      const outcome = await events.waitForDelivery(
        (frame) => frame.status !== "running",
      );
      expect(outcome).toMatchObject({ status: "skipped", reason: "no-repository" });
    } finally {
      events.close();
      await server.stop();
    }
  });

  test("delivers nothing at all with --no-deliver", async () => {
    const project = await deliveryProject();
    const logPath = join(project.root, "gh.log");
    const server = await startServer([card("acceptance")], {
      boardPath: project.boardPath,
      args: ["--no-deliver"],
      stubs: { gh: ghStub() },
      env: { GH_LOG: logPath },
    });
    const events = await openEvents(server.base);
    try {
      expect((await patchCard(server.base, "OV-1", { state: "done" })).status).toBe(200);
      await Bun.sleep(750);
      expect(events.deliveries()).toEqual([]);
      expect(await ghCalls(logPath)).toEqual([]);
    } finally {
      events.close();
      await server.stop();
    }
  });
});
