/**
 * `POST /api/items` card creation.
 *
 * Covers what OV-109-C1 changes: the create dialog no longer asks for a
 * `project`, so the two things it used to decide are decided here instead.
 *   - the new card's id prefix came from the request's `project`, which put
 *     `OVER-111` on a board whose other cards were all `OV-`;
 *   - `project` itself was whatever the dialog's optional field held.
 *
 * The server is a script that starts listening on import, so every case runs
 * it as a real process against a throwaway board and speaks HTTP to it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/**
 * Start the console server on a throwaway board.
 *
 * `cmux` is stubbed to a script that fails and CMUX_SOCK points at a path
 * that does not exist, so the test process never reaches the cmux app the
 * user is running. Neither is needed by the board API.
 */
async function startServer(items: Item[]): Promise<RunningServer> {
  const dir = await scratch();
  const boardPath = join(dir, "board.yaml");
  const board: Board = { version: 1, updated_at: null, items };
  await saveBoard(boardPath, board);

  const stub = join(dir, "cmux");
  await writeFile(stub, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(stub, 0o755);

  const port = await freePort();
  const proc = Bun.spawn(
    [process.execPath, "run", serverPath, "--board", boardPath, "--port", String(port)],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        CMUX_BIN: stub,
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
