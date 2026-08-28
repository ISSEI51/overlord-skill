/**
 * board.yaml write path.
 *
 * Covers the defects OV-104-C1 and OV-104-C2 fix:
 *   - `revisionOf` used millisecond mtime, so two writes of equal byte length
 *     inside one millisecond produced the same token (C1);
 *   - `loadBoard` -> mutate -> `saveBoard` was not a critical section, so two
 *     concurrent writers in one process interleaved and the first write was
 *     lost silently (C1);
 *   - the atomic-rename staging file had a fixed name, so two processes
 *     writing at once collided on it: `rename ENOENT` on one side and, once
 *     measured, a truncated NUL-padded board.yaml (C2);
 *   - nothing serialized writers across processes, so the console and the
 *     `change` CLI overwrote each other with no conflict reported (C2).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boardLock,
  BoardConflictError,
  BoardLockError,
  EMPTY_BOARD,
  loadBoard,
  lockPathFor,
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

const LOCK_DEFAULTS = { ...boardLock };

afterEach(async () => {
  Object.assign(boardLock, LOCK_DEFAULTS);
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

/**
 * Source of the child process used by the cross-process tests.
 *
 * It is written to the test's temporary directory and run with the same bun
 * binary, importing board.ts by absolute path, so the child exercises exactly
 * the write path under test.
 */
const WRITER_SOURCE = `
const [modulePath, boardPath, tag, roundsRaw] = Bun.argv.slice(2);
const { mutateBoard } = await import(modulePath);
const rounds = Number(roundsRaw);
const failures = [];
const errors = [];
for (let round = 0; round < rounds; round += 1) {
  try {
    await mutateBoard(boardPath, undefined, (board) => {
      board.items.push({ id: \`\${tag}-\${round}\`, title: tag, state: "inbox" });
    });
  } catch (error) {
    failures.push(round);
    const name = error && error.name ? error.name : "Error";
    const code = error && error.code ? error.code : "";
    if (name !== "BoardLockError" && name !== "BoardConflictError") {
      errors.push(\`\${name}/\${code}: \${error && error.message}\`);
    }
  }
}
process.stdout.write(JSON.stringify({ tag, failures, errors }));
`;

/** Holds the lock and never releases it, so the parent has to time it out. */
const HOLDER_SOURCE = `
const [modulePath, boardPath] = Bun.argv.slice(2);
const { mutateBoard } = await import(modulePath);
await mutateBoard(boardPath, undefined, async () => {
  process.stdout.write("held\\n");
  // Never returns: the parent kills this process while the lock is held.
  await new Promise(() => {});
});
`;

type WriterReport = { tag: string; failures: number[]; errors: string[] };

const boardModulePath = join(import.meta.dir, "board.ts");

describe("cross-process board writes", () => {
  test(
    "two processes, 100 rounds each: no ENOENT, no corruption, no lost write",
    async () => {
      await seed([]);
      const script = join(dir, "writer.ts");
      await writeFile(script, WRITER_SOURCE, "utf8");
      const rounds = 100;

      const children = ["P1", "P2"].map((tag) =>
        Bun.spawn(
          [process.execPath, "run", script, boardModulePath, boardPath, tag, String(rounds)],
          { stdout: "pipe", stderr: "pipe" },
        ),
      );
      const reports: WriterReport[] = [];
      for (const child of children) {
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        const code = await child.exited;
        expect(stderr).toBe("");
        expect(code).toBe(0);
        reports.push(JSON.parse(stdout) as WriterReport);
      }

      // (a) No writer hit `rename ENOENT` (or any error other than a
      // reported conflict) on the shared staging file.
      for (const report of reports) expect(report.errors).toEqual([]);

      // (b) The board is still parseable YAML with the shape it started with.
      const { board } = await loadBoard(boardPath);
      expect(board.version).toBe(1);

      // (c) Every write that was not reported as a conflict is on the board,
      // and nothing else is: no writer's item was silently overwritten.
      const expected = new Set<string>();
      for (const report of reports) {
        const failed = new Set(report.failures);
        for (let round = 0; round < rounds; round += 1) {
          if (!failed.has(round)) expected.add(`${report.tag}-${round}`);
        }
      }
      const written = board.items.map((entry) => entry.id);
      expect(new Set(written)).toEqual(expected);
      expect(written).toHaveLength(expected.size);

      // With writes this short neither process should ever wait out the
      // 5 s acquire timeout, so in practice nothing is dropped at all.
      for (const report of reports) expect(report.failures).toEqual([]);

      // No staging file and no lock file survive the run.
      const leftovers = (await readdir(dir)).filter(
        (name) => name.includes(".overlord-tmp.") || name.endsWith(".lock"),
      );
      expect(leftovers).toEqual([]);
    },
    120_000,
  );

  test(
    "reclaims the lock of a process that was killed while holding it",
    async () => {
      await seed([item("A-1")]);
      const script = join(dir, "holder.ts");
      await writeFile(script, HOLDER_SOURCE, "utf8");

      const holder = Bun.spawn(
        [process.execPath, "run", script, boardModulePath, boardPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      // Wait until the child reports that it owns the lock.
      const reader = holder.stdout.getReader();
      await reader.read();
      expect(existsSync(lockPathFor(boardPath))).toBe(true);
      holder.kill("SIGKILL");
      await holder.exited;
      // The lock file outlives the process that was killed.
      expect(existsSync(lockPathFor(boardPath))).toBe(true);

      boardLock.staleAfterMs = 200;
      boardLock.acquireTimeoutMs = 10_000;
      await mutateBoard(boardPath, undefined, (board) => {
        board.items.push(item("A-2"));
      });

      const { board } = await loadBoard(boardPath);
      expect(board.items.map((entry) => entry.id)).toEqual(["A-1", "A-2"]);
      expect(existsSync(lockPathFor(boardPath))).toBe(false);
    },
    30_000,
  );
});

describe("board lock", () => {
  test("takes over a lock whose mtime is older than staleAfterMs", async () => {
    await seed([item("A-1")]);
    const lockPath = lockPathFor(boardPath);
    await writeFile(lockPath, "99999\n", "utf8");
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath, longAgo, longAgo);

    await mutateBoard(boardPath, undefined, (board) => {
      board.items.push(item("A-2"));
    });

    const { board } = await loadBoard(boardPath);
    expect(board.items.map((entry) => entry.id)).toEqual(["A-1", "A-2"]);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reports a conflict instead of writing when the lock is held", async () => {
    const rev = await seed([item("A-1")]);
    const lockPath = lockPathFor(boardPath);
    // A live holder: this process. A dead pid is reclaimed at once instead.
    await writeFile(lockPath, `${process.pid}\n`, "utf8");
    boardLock.acquireTimeoutMs = 150;

    const failure = await mutateBoard(boardPath, undefined, (board) => {
      board.items.push(item("A-2"));
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BoardLockError);
    // A lock timeout is a conflict, so the server answers 409 for it.
    expect(failure).toBeInstanceOf(BoardConflictError);
    expect((failure as BoardLockError).rev).toBe(rev);
    // Nothing was written and the live lock was left alone.
    expect(await revisionOf(boardPath)).toBe(rev);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("a lock left by a dead process is reclaimed without waiting", async () => {
    await seed([item("A-1")]);
    const lockPath = lockPathFor(boardPath);
    // Fresh mtime, so the staleness window has not passed: only the pid tells
    // us the holder crashed. Without that check this waited the full timeout.
    await writeFile(lockPath, "99999\n", "utf8");
    boardLock.acquireTimeoutMs = 5_000;

    const started = performance.now();
    const { board } = await mutateBoard(boardPath, undefined, (current) => {
      current.items.push(item("A-2"));
    });

    expect(board.items).toHaveLength(2);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releases the lock when the mutation throws", async () => {
    await seed([item("A-1")]);
    const lockPath = lockPathFor(boardPath);

    const failure = await mutateBoard(boardPath, undefined, () => {
      expect(existsSync(lockPath)).toBe(true);
      throw new Error("rejected by the handler");
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe("rejected by the handler");
    expect(existsSync(lockPath)).toBe(false);

    // And the next writer can still take it.
    await mutateBoard(boardPath, undefined, (board) => {
      board.items.push(item("A-2"));
    });
    expect(existsSync(lockPath)).toBe(false);
    const { board } = await loadBoard(boardPath);
    expect(board.items.map((entry) => entry.id)).toEqual(["A-1", "A-2"]);
  });

  test("releases the lock when a stale expected revision is rejected", async () => {
    const stale = await seed([item("A-1")]);
    await mutateBoard(boardPath, stale, (board) => board.items.push(item("A-2")));

    const conflict = await mutateBoard(boardPath, stale, (board) => {
      board.items.push(item("A-3"));
    }).catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(BoardConflictError);
    expect(existsSync(lockPathFor(boardPath))).toBe(false);
  });

  test("re-applies the mutation when an unlocked writer changed the file", async () => {
    await seed([item("A-1")]);
    let passes = 0;

    await mutateBoard(boardPath, undefined, async (board) => {
      passes += 1;
      if (passes === 1) {
        // A writer that ignores the lock entirely (a person with an editor).
        const { board: outside } = await loadBoard(boardPath);
        outside.items.push(item("OUTSIDE"));
        await saveBoard(boardPath, outside);
      }
      board.items.push(item("MINE"));
    });

    expect(passes).toBe(2);
    const { board } = await loadBoard(boardPath);
    // Neither the outside edit nor the mutation was lost.
    expect(board.items.map((entry) => entry.id)).toEqual([
      "A-1",
      "OUTSIDE",
      "MINE",
    ]);
  });
});

describe("saveBoard staging file", () => {
  test("no longer uses the fixed name two processes collided on", async () => {
    // The old staging name, occupied by something `writeFile` cannot write
    // to. Before OV-104-C2 the save would fail here with EISDIR, which is
    // the in-process shadow of the `rename ENOENT` two processes hit.
    await mkdir(`${boardPath}.overlord-tmp`);

    await seed([item("A-1")]);

    const { board } = await loadBoard(boardPath);
    expect(board.items.map((entry) => entry.id)).toEqual(["A-1"]);
    const leftovers = (await readdir(dir)).filter(
      (name) => name.startsWith("board.yaml.overlord-tmp."),
    );
    expect(leftovers).toEqual([]);
  });

  test("removes its staging file when the rename fails", async () => {
    // A non-empty directory where the board file should be: the write
    // succeeds, the rename onto it cannot.
    const target = join(dir, "occupied.yaml");
    await mkdir(join(target, "child"), { recursive: true });
    const board: Board = { ...structuredClone(EMPTY_BOARD), items: [item("A-1")] };

    const failure = await saveBoard(target, board).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const leftovers = (await readdir(dir)).filter((name) =>
      name.includes(".overlord-tmp."),
    );
    expect(leftovers).toEqual([]);
  });
});

/**
 * The card-level `delivery` record (OV-105-C1).
 *
 * It is written by `change deliver`, so the write path has to keep it in the
 * same canonical shape as `changes[]`: `delivery` between `changes` and
 * `updated_at`, and its nested `pr` in the same key order a change's pull
 * request uses.
 */
describe("delivery key order", () => {
  const DELIVERED: Item = {
    id: "OV-105",
    // Written out of schema order on purpose: the writer must reorder.
    updated_at: "2026-08-01T00:00:00Z",
    delivery: {
      attempted_at: "2026-08-02T00:00:00Z",
      error: null,
      pr: {
        reviewed_sha: null,
        head_sha: "a".repeat(40),
        state: "open",
        url: "https://github.com/o/r/pull/9",
        number: 9,
      },
      base: "main",
      branch: "overlord-console",
    },
    changes: [{ id: "OV-105-C1", title: "A change", state: "done" }],
    title: "A delivered card",
    state: "acceptance",
  };

  test("delivery is written between changes and updated_at", async () => {
    await saveBoard(boardPath, {
      ...structuredClone(EMPTY_BOARD),
      items: [structuredClone(DELIVERED)],
    });

    const text = await Bun.file(boardPath).text();
    const keys = [...text.matchAll(/^ {4}([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(["title", "state", "changes", "delivery", "updated_at"]);
  });

  test("the delivery pull request keeps the change pull request key order", async () => {
    await saveBoard(boardPath, {
      ...structuredClone(EMPTY_BOARD),
      items: [structuredClone(DELIVERED)],
    });

    const text = await Bun.file(boardPath).text();
    const block = text.slice(text.indexOf("delivery:"));
    const keys = [...block.matchAll(/^ {6,8}([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      "branch",
      "base",
      "pr",
      "number",
      "url",
      "state",
      "head_sha",
      "reviewed_sha",
      "error",
      "attempted_at",
    ]);
  });

  test("a card without a delivery is unchanged", async () => {
    await saveBoard(boardPath, {
      ...structuredClone(EMPTY_BOARD),
      items: [item("OV-106")],
    });

    const text = await Bun.file(boardPath).text();
    expect(text).not.toContain("delivery");
    const reloaded = await loadBoard(boardPath);
    expect(reloaded.board.items[0]!.delivery).toBeUndefined();
  });

  test("a delivery survives a load and a save unchanged", async () => {
    await saveBoard(boardPath, {
      ...structuredClone(EMPTY_BOARD),
      items: [structuredClone(DELIVERED)],
    });
    const first = await Bun.file(boardPath).text();

    const reloaded = await loadBoard(boardPath);
    expect(reloaded.board.items[0]!.delivery).toEqual(DELIVERED.delivery!);
    await saveBoard(boardPath, reloaded.board);

    // Only `updated_at` at the top of the file is restamped by the writer.
    const second = await Bun.file(boardPath).text();
    expect(second.split("\n").slice(2)).toEqual(first.split("\n").slice(2));
  });
});
