import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadBoard, saveBoard, type Board } from "./board.ts";
import {
  branchNameFor,
  ChangeNotFoundError,
  findChange,
  parseArgs,
  parseWorktreePaths,
  resolveBoardPath,
  updateChange,
  worktreePathFor,
} from "./change.ts";

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overlord-change-"));
  temporaries.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

function sampleBoard(): Board {
  return {
    version: 1,
    updated_at: "2026-08-01T00:00:00Z",
    items: [
      {
        id: "OV-100",
        title: "First card",
        state: "specified",
        changes: [
          { id: "OV-100-C1", title: "First change", state: "specified" },
        ],
      },
      {
        id: "OV-103",
        title: "Second card",
        state: "specified",
        next_action: "start the first change",
        updated_at: "2026-08-02T00:00:00Z",
        changes: [
          {
            id: "OV-103-C1",
            title: "Record helper",
            state: "specified",
            branch: null,
          },
          { id: "OV-103-C2", title: "Pull request", state: "specified" },
        ],
      },
      { id: "OV-104", title: "No changes", state: "inbox" },
    ],
  };
}

async function writeSampleBoard(): Promise<string> {
  const boardPath = join(await scratch(), "board.yaml");
  await saveBoard(boardPath, sampleBoard());
  return boardPath;
}

describe("findChange", () => {
  test("resolves a change id to its card and position", () => {
    const board = sampleBoard();
    const found = findChange(board, "OV-103-C2");
    expect(found).not.toBeNull();
    expect(found!.item.id).toBe("OV-103");
    expect(found!.change.title).toBe("Pull request");
    expect(found!.index).toBe(1);
    expect(found!.change).toBe(board.items[1]!.changes![1]!);
  });

  test("matches the change id exactly", () => {
    const board = sampleBoard();
    expect(findChange(board, "OV-103")).toBeNull();
    expect(findChange(board, "OV-103-C")).toBeNull();
    expect(findChange(board, "ov-103-c1")).toBeNull();
  });

  test("returns null for an unknown id and tolerates cards without changes", () => {
    expect(findChange(sampleBoard(), "OV-999-C1")).toBeNull();
  });
});

describe("naming", () => {
  test("branch name is overlord/<change-id>", () => {
    expect(branchNameFor("OV-103-C1")).toBe("overlord/OV-103-C1");
  });

  test("worktree path is <repo-root>/.overlord/worktrees/<change-id>", () => {
    expect(worktreePathFor("/repo", "OV-103-C1")).toBe(
      "/repo/.overlord/worktrees/OV-103-C1",
    );
  });

  test("worktree path is absolute even for a relative root", () => {
    expect(worktreePathFor(".", "OV-1-C1")).toBe(
      resolve(process.cwd(), ".overlord/worktrees/OV-1-C1"),
    );
  });
});

describe("parseWorktreePaths", () => {
  test("reads the worktree lines of the porcelain listing", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo/.overlord/worktrees/OV-103-C1",
      "HEAD def",
      "branch refs/heads/overlord/OV-103-C1",
      "",
    ].join("\n");
    expect(parseWorktreePaths(porcelain)).toEqual([
      "/repo",
      "/repo/.overlord/worktrees/OV-103-C1",
    ]);
  });

  test("returns nothing for an empty listing", () => {
    expect(parseWorktreePaths("")).toEqual([]);
  });
});

describe("parseArgs", () => {
  test("splits positionals from --key value options", () => {
    expect(parseArgs(["OV-103-C1", "--board", "/tmp/board.yaml"])).toEqual({
      positional: ["OV-103-C1"],
      options: { board: "/tmp/board.yaml" },
    });
  });

  test("accepts --key=value", () => {
    expect(parseArgs(["--base=main", "OV-1-C1"])).toEqual({
      positional: ["OV-1-C1"],
      options: { base: "main" },
    });
  });

  test("rejects an option without a value", () => {
    expect(() => parseArgs(["--board"])).toThrow("option --board needs a value");
  });
});

describe("resolveBoardPath", () => {
  test("appends the standard board suffix to a directory", () => {
    expect(resolveBoardPath("/project")).toBe(
      "/project/docs/product-ops/board.yaml",
    );
  });

  test("keeps an explicit yaml path", () => {
    expect(resolveBoardPath("/tmp/board.yaml")).toBe("/tmp/board.yaml");
  });

  test("falls back to OVERLORD_BOARD", () => {
    const previous = process.env.OVERLORD_BOARD;
    process.env.OVERLORD_BOARD = "/env/board.yaml";
    try {
      expect(resolveBoardPath()).toBe("/env/board.yaml");
    } finally {
      if (previous === undefined) delete process.env.OVERLORD_BOARD;
      else process.env.OVERLORD_BOARD = previous;
    }
  });
});

describe("updateChange", () => {
  test("writes the target change and leaves everything else alone", async () => {
    const boardPath = await writeSampleBoard();
    const before = await loadBoard(boardPath);

    await updateChange(boardPath, "OV-103-C1", (change) => {
      change.branch = "overlord/OV-103-C1";
      change.state = "implementing";
    });

    const after = await loadBoard(boardPath);
    const target = findChange(after.board, "OV-103-C1")!;
    expect(target.change.branch).toBe("overlord/OV-103-C1");
    expect(target.change.state).toBe("implementing");

    // The owning card, its sibling change and the other cards are untouched.
    expect(target.item.state).toBe("specified");
    expect(target.item.next_action).toBe("start the first change");
    expect(target.item.updated_at).toBe("2026-08-02T00:00:00Z");
    expect(findChange(after.board, "OV-103-C2")!.change).toEqual(
      findChange(before.board, "OV-103-C2")!.change,
    );
    expect(after.board.items[0]).toEqual(before.board.items[0]!);
    expect(after.board.items[2]).toEqual(before.board.items[2]!);
    expect(after.board.items.length).toBe(before.board.items.length);
  });

  test("keeps the change key order used by the console writer", async () => {
    const boardPath = await writeSampleBoard();

    await updateChange(boardPath, "OV-103-C1", (change) => {
      // Assigned out of schema order on purpose: canonicalItem must reorder.
      change.state = "implementing";
      change.branch = "overlord/OV-103-C1";
    });

    const text = await Bun.file(boardPath).text();
    const start = text.indexOf('- id: "OV-103-C1"');
    const block = text.slice(start, text.indexOf('- id: "OV-103-C2"'));
    const keys = [...block.matchAll(/^\s*(?:- )?([a-z_]+):/gm)].map(
      (match) => match[1],
    );
    expect(keys).toEqual(["id", "title", "state", "branch"]);
    expect(text).toContain('branch: "overlord/OV-103-C1"');
  });

  test("re-reads and re-applies when the board changed after loading", async () => {
    const boardPath = await writeSampleBoard();
    let mutations = 0;

    await updateChange(boardPath, "OV-103-C1", (change) => {
      mutations += 1;
      // On the first pass, simulate a console write landing between the load
      // and the save. It changes the file size, so the revision differs and
      // the helper must re-read before writing.
      if (mutations === 1) {
        const text = readFileSync(boardPath, "utf8").replace(
          '"start the first change"',
          '"written by the console while the CLI was running"',
        );
        writeFileSync(boardPath, text, "utf8");
      }
      change.branch = "overlord/OV-103-C1";
      change.state = "implementing";
    });

    expect(mutations).toBe(2);
    const after = await loadBoard(boardPath);
    const target = findChange(after.board, "OV-103-C1")!;
    expect(target.change.branch).toBe("overlord/OV-103-C1");
    expect(target.change.state).toBe("implementing");
    // The concurrent edit is preserved instead of being overwritten.
    expect(target.item.next_action).toBe(
      "written by the console while the CLI was running",
    );
  });

  test("throws for an unknown change id and leaves the board byte-identical", async () => {
    const boardPath = await writeSampleBoard();
    const before = await Bun.file(boardPath).text();

    let thrown: unknown = null;
    try {
      await updateChange(boardPath, "OV-999-C1", (change) => {
        change.state = "implementing";
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChangeNotFoundError);
    expect(await Bun.file(boardPath).text()).toBe(before);
  });
});
