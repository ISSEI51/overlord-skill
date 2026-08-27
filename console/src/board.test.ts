/**
 * board.yaml write path.
 *
 * Covers the two defects OV-104-C1 fixes:
 *   - `revisionOf` used millisecond mtime, so two writes of equal byte length
 *     inside one millisecond produced the same token;
 *   - `loadBoard` -> mutate -> `saveBoard` was not a critical section, so two
 *     concurrent writers interleaved and the first write was lost silently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoardConflictError,
  EMPTY_BOARD,
  loadBoard,
  mutateBoard,
  revisionOf,
  saveBoard,
  type Board,
  type Item,
} from "./board.ts";

let dir = "";
let boardPath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "overlord-board-"));
  boardPath = join(dir, "board.yaml");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function item(id: string): Item {
  return { id, title: id, state: "inbox" };
}

async function seed(items: Item[] = []): Promise<string> {
  const board: Board = { ...structuredClone(EMPTY_BOARD), items };
  return saveBoard(boardPath, board);
}

describe("revisionOf", () => {
  test("separates same-size writes made inside one millisecond", async () => {
    const path = join(dir, "same-size.txt");
    /** Milliseconds the `<mtimeNs>:<size>` token would collapse to. */
    const millisecond = (rev: string) => Number(BigInt(rev.split(":")[0]!) / 1_000_000n);

    let pairs = 0;
    for (let attempt = 0; attempt < 400 && pairs < 5; attempt += 1) {
      const before = Date.now();
      await writeFile(path, "aaaa", "utf8");
      const first = await revisionOf(path);
      await writeFile(path, "bbbb", "utf8");
      const second = await revisionOf(path);
      if (before !== Date.now()) continue;
      if (millisecond(first) !== millisecond(second)) continue;

      // Both writes landed in the same millisecond and have the same byte
      // length, so the old `round(mtimeMs):size` token could not tell them
      // apart and neither 409 nor the SSE board frame fired.
      pairs += 1;
      expect(first.split(":")[1]).toBe(second.split(":")[1]);
      expect(second).not.toBe(first);
    }
    expect(pairs).toBeGreaterThan(0);
  });

  test("reports absent for a file that does not exist", async () => {
    expect(await revisionOf(join(dir, "missing.yaml"))).toBe("absent");
  });

  test("changes on every save", async () => {
    const first = await seed([item("A-1")]);
    const second = await mutateBoard(boardPath, first, (board) => {
      board.items.push(item("A-2"));
    });
    expect(second.rev).not.toBe(first);
    expect(await revisionOf(boardPath)).toBe(second.rev);
  });
});

describe("mutateBoard", () => {
  test("applies the mutation and returns the new revision", async () => {
    const rev = await seed([item("A-1")]);
    const written = await mutateBoard(boardPath, rev, (board) => {
      board.items.push(item("A-2"));
      return board.items.length;
    });
    expect(written.result).toBe(2);
    const reloaded = await loadBoard(boardPath);
    expect(reloaded.board.items.map((entry) => entry.id)).toEqual(["A-1", "A-2"]);
    expect(reloaded.rev).toBe(written.rev);
  });

  test("rejects a stale expected revision without writing", async () => {
    const stale = await seed([item("A-1")]);
    await mutateBoard(boardPath, stale, (board) => {
      board.items.push(item("A-2"));
    });
    const current = await revisionOf(boardPath);

    const conflict = await mutateBoard(boardPath, stale, (board) => {
      board.items.push(item("A-3"));
    }).catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(BoardConflictError);
    expect((conflict as BoardConflictError).rev).toBe(current);
    // Nothing was written, so the file is untouched.
    expect(await revisionOf(boardPath)).toBe(current);
    const { board } = await loadBoard(boardPath);
    expect(board.items.map((entry) => entry.id)).toEqual(["A-1", "A-2"]);
  });

  test("two concurrent writers on one revision: one wins, one conflicts, no write is lost", async () => {
    const rev = await seed([item("A-1")]);

    // Both calls are issued without awaiting the first, the way two
    // un-awaited PATCH handlers overlap inside Bun.serve.
    const first = mutateBoard(boardPath, rev, (board) => {
      board.items.push(item("FIRST"));
    });
    const second = mutateBoard(boardPath, rev, (board) => {
      board.items.push(item("SECOND"));
    });

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      BoardConflictError,
    );

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ rev: string }>).value;
    const { board, rev: onDisk } = await loadBoard(boardPath);
    expect(onDisk).toBe(winner.rev);
    // The winning writer's change survives; the loser wrote nothing.
    expect(board.items.map((entry) => entry.id)).toEqual(["A-1", "FIRST"]);
  });

  test("keeps writing without an expected revision", async () => {
    await seed([item("A-1")]);
    for (const expected of [undefined, null, ""]) {
      const written = await mutateBoard(boardPath, expected, (board) => {
        board.items.push(item(`X-${board.items.length}`));
      });
      expect(written.rev).toBe(await revisionOf(boardPath));
    }
    const { board } = await loadBoard(boardPath);
    expect(board.items.map((entry) => entry.id)).toEqual([
      "A-1",
      "X-1",
      "X-2",
      "X-3",
    ]);
  });

  test("creates the board file when it does not exist yet", async () => {
    const written = await mutateBoard(boardPath, undefined, (board) => {
      board.items.push(item("A-1"));
    });
    const { board, exists, rev } = await loadBoard(boardPath);
    expect(exists).toBe(true);
    expect(rev).toBe(written.rev);
    expect(board.items.map((entry) => entry.id)).toEqual(["A-1"]);
  });

  test("serializes concurrent writers: no load/save pair nests inside another", async () => {
    await seed([]);

    let inside = 0;
    let maxInside = 0;
    const order: string[] = [];

    const writers = ["w1", "w2", "w3", "w4", "w5"].map((name) =>
      mutateBoard(boardPath, undefined, async (board) => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        order.push(name);
        // Yield inside the critical section: without serialization another
        // writer would load the board here and overwrite this one's item.
        await new Promise((resolve) => setTimeout(resolve, 5));
        board.items.push(item(name));
        inside -= 1;
      }),
    );

    await Promise.all(writers);

    expect(maxInside).toBe(1);
    expect(order).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    const { board } = await loadBoard(boardPath);
    // Every writer's item is present: no write was lost.
    expect(board.items.map((entry) => entry.id)).toEqual([
      "w1",
      "w2",
      "w3",
      "w4",
      "w5",
    ]);
  });

  test("an aborted mutation writes nothing and leaves the queue usable", async () => {
    const rev = await seed([item("A-1")]);

    const failure = await mutateBoard(boardPath, rev, () => {
      throw new Error("rejected by the handler");
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("rejected by the handler");
    expect(await revisionOf(boardPath)).toBe(rev);

    const written = await mutateBoard(boardPath, rev, (board) => {
      board.items.push(item("A-2"));
    });
    const { board } = await loadBoard(boardPath);
    expect(board.items.map((entry) => entry.id)).toEqual(["A-1", "A-2"]);
    expect(written.rev).toBe(await revisionOf(boardPath));
  });

  test("serializes per path: two boards do not block each other", async () => {
    const other = join(dir, "other.yaml");
    await seed([]);
    const [a, b] = await Promise.all([
      mutateBoard(boardPath, undefined, (board) => board.items.push(item("A-1"))),
      mutateBoard(other, undefined, (board) => board.items.push(item("B-1"))),
    ]);
    expect(a.rev).toBe(await revisionOf(boardPath));
    expect(b.rev).toBe(await revisionOf(other));
    expect((await loadBoard(other)).board.items.map((e) => e.id)).toEqual(["B-1"]);
  });
});
