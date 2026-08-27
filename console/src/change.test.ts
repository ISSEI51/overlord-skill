import { afterAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as boardModule from "./board.ts";
import { loadBoard, saveBoard, type Board, type Change } from "./board.ts";
import {
  applyPullRequestView,
  branchNameFor,
  ChangeNotFoundError,
  changeStateForPr,
  findChange,
  normalizePrState,
  parseArgs,
  parsePrNumber,
  parseWorktreePaths,
  pr,
  prBodyFor,
  prTitleFor,
  resolveBoardPath,
  sync,
  syncLine,
  syncTargets,
  updateChange,
  updateChanges,
  worktreePathFor,
  type PullRequestView,
} from "./change.ts";

/**
 * Count board writes.
 *
 * `sync` must write `board.yaml` once per run, whatever number of pull
 * requests it read, because every write makes the console re-render. The real
 * `saveBoard` is kept and only wrapped, so every other test keeps its exact
 * behaviour and only the counter is added.
 */
const realSaveBoard = boardModule.saveBoard;
let saveCount = 0;
mock.module("./board.ts", () => ({
  ...boardModule,
  saveBoard: (path: string, board: Board) => {
    saveCount += 1;
    return realSaveBoard(path, board);
  },
}));

/** Board writes performed while `body` ran. */
async function countSaves(body: () => Promise<unknown>): Promise<number> {
  const before = saveCount;
  await body();
  return saveCount - before;
}

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

/** Run something with stderr captured, so a failing command stays quiet. */
async function captureStderr(
  body: () => Promise<number>,
): Promise<{ code: number; stderr: string }> {
  const { code, stderr } = await capture(body);
  return { code, stderr };
}

/**
 * Run the `change` CLI as a subprocess with a fake `gh` in front of PATH.
 *
 * The command shells out to `gh`, and Bun resolves executables from the PATH
 * its process started with, so PATH cannot be redirected from inside the test
 * process. Running the CLI as a child process is what makes the stub take
 * effect, and it also guarantees the tests never reach GitHub: the stub
 * answers `gh pr view` from a fixed JSON document and fails every other `gh`
 * subcommand, so a test that tried to push or to create a pull request would
 * fail instead of doing it. The git calls the CLI makes are read-only
 * (`rev-parse`) and run against the real repository.
 */
async function runChangeCli(
  args: string[],
  ghView: Record<string, unknown>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await scratch();
  const script = join(dir, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      "  cat <<'JSON'",
      JSON.stringify(ghView),
      "JSON",
      "  exit 0",
      "fi",
      'echo "stub gh: unexpected call: $*" >&2',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(script, 0o755);

  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "change.ts"), ...args],
    {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

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

/**
 * A board where OV-103-C1 has been started and already carries the correct
 * pull request record, which is what a mistyped `--number` would overwrite.
 */
async function writeStartedBoard(): Promise<string> {
  const board = sampleBoard();
  const change = findChange(board, "OV-103-C1")!.change;
  change.state = "reviewing";
  change.branch = "overlord/OV-103-C1";
  change.pr = {
    number: 3,
    url: "https://github.com/example/repo/pull/3",
    state: "open",
    head_sha: "1111111111111111111111111111111111111111",
    reviewed_sha: null,
  };
  const boardPath = join(await scratch(), "board.yaml");
  await saveBoard(boardPath, board);
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

describe("normalizePrState", () => {
  test("lower-cases the states GitHub reports", () => {
    expect(normalizePrState("OPEN")).toBe("open");
    expect(normalizePrState("MERGED")).toBe("merged");
    expect(normalizePrState("CLOSED")).toBe("closed");
  });

  test("passes an unknown state through in lower case", () => {
    expect(normalizePrState("DRAFT")).toBe("draft");
    expect(normalizePrState(" Open \n")).toBe("open");
  });

  test("is null when there is no state to record", () => {
    expect(normalizePrState("")).toBeNull();
    expect(normalizePrState("   ")).toBeNull();
    expect(normalizePrState(null)).toBeNull();
    expect(normalizePrState(undefined)).toBeNull();
    expect(normalizePrState(3)).toBeNull();
  });
});

describe("parsePrNumber", () => {
  test("accepts a decimal pull request number", () => {
    expect(parsePrNumber("3")).toBe(3);
    expect(parsePrNumber("12")).toBe(12);
    expect(parsePrNumber("007")).toBe(7);
  });

  test("rejects values Number.parseInt would silently truncate", () => {
    // Every one of these used to parse: 1abc -> 1, 3.9 -> 3, 1e3 -> 1.
    expect(parsePrNumber("1abc")).toBeNull();
    expect(parsePrNumber("3.9")).toBeNull();
    expect(parsePrNumber("1e3")).toBeNull();
    expect(parsePrNumber("12 ")).toBeNull();
    expect(parsePrNumber(" 12")).toBeNull();
    expect(parsePrNumber("+12")).toBeNull();
    expect(parsePrNumber("0x10")).toBeNull();
  });

  test("rejects values that are not a positive number", () => {
    expect(parsePrNumber("")).toBeNull();
    expect(parsePrNumber("0")).toBeNull();
    expect(parsePrNumber("-1")).toBeNull();
    expect(parsePrNumber("not-a-number")).toBeNull();
    expect(parsePrNumber("99999999999999999999")).toBeNull();
  });
});

describe("changeStateForPr", () => {
  test("an open pull request puts the change in review", () => {
    expect(changeStateForPr("open", "implementing")).toBe("reviewing");
    expect(changeStateForPr("draft", "implementing")).toBe("reviewing");
    expect(changeStateForPr(null, "implementing")).toBe("reviewing");
  });

  test("a merged pull request marks the change done", () => {
    expect(changeStateForPr("merged", "implementing")).toBe("done");
    expect(changeStateForPr("merged", "reviewing")).toBe("done");
  });

  test("a closed pull request leaves the change state alone", () => {
    expect(changeStateForPr("closed", "implementing")).toBe("implementing");
    expect(changeStateForPr("closed", "blocked")).toBe("blocked");
  });
});

describe("pull request text", () => {
  test("the title is the change title with its id appended", () => {
    const change = findChange(sampleBoard(), "OV-103-C2")!.change;
    expect(prTitleFor(change)).toBe("Pull request (OV-103-C2)");
  });

  test("the body names the card, the change and both ids", () => {
    const found = findChange(sampleBoard(), "OV-103-C2")!;
    const body = prBodyFor(found.item, found.change);
    expect(body).toContain("Second card");
    expect(body).toContain("Pull request");
    expect(body).toContain("Card: OV-103");
    expect(body).toContain("Change: OV-103-C2");
  });
});

describe("pr", () => {
  test("fails without writing the board when the change has no branch", async () => {
    const boardPath = await writeSampleBoard();
    const before = await Bun.file(boardPath).text();

    // OV-103-C2 has never been started, so there is nothing to push.
    const { code, stderr } = await captureStderr(() =>
      pr(["OV-103-C2", "--board", boardPath]),
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain("has no branch on the board");
    expect(stderr).toContain("change start OV-103-C2");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("rejects a --number that is not a pull request number", async () => {
    const boardPath = await writeStartedBoard();
    const before = await Bun.file(boardPath).text();

    for (const value of ["not-a-number", "1abc", "3.9", "1e3", "0", "-1"]) {
      const { code, stderr } = await captureStderr(() =>
        pr(["OV-103-C1", "--board", boardPath, "--number", value]),
      );

      expect(code).toBe(2);
      expect(stderr).toContain(`--number must be a pull request number: ${value}`);
      // The correct record that was already on the board survives.
      expect(await Bun.file(boardPath).text()).toBe(before);
    }
  });

  test("refuses a pull request whose head branch is not the change branch", async () => {
    const boardPath = await writeStartedBoard();
    const before = await Bun.file(boardPath).text();

    // The number of an unrelated, already merged pull request: what a typo in
    // `--number` produces. It used to be recorded over the correct one.
    const { code, stderr } = await runChangeCli(
      ["pr", "OV-103-C1", "--board", boardPath, "--base", "main", "--number", "1"],
      {
        number: 1,
        url: "https://github.com/example/repo/pull/1",
        state: "MERGED",
        headRefOid: "2222222222222222222222222222222222222222",
        headRefName: "some/other-branch",
      },
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain("pull request #1 is on branch");
    expect(stderr).toContain("some/other-branch");
    expect(stderr).toContain("overlord/OV-103-C1");
    // Nothing is written, so the pull request already recorded is intact.
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("records a matching pull request and marks a merged one done", async () => {
    const boardPath = await writeStartedBoard();

    const { code, stderr } = await runChangeCli(
      [
        "pr",
        "OV-103-C1",
        "--board",
        boardPath,
        "--base",
        "main",
        "--number",
        "12",
      ],
      {
        number: 12,
        url: "https://github.com/example/repo/pull/12",
        state: "MERGED",
        headRefOid: "3333333333333333333333333333333333333333",
        headRefName: "overlord/OV-103-C1",
      },
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    const after = await loadBoard(boardPath);
    const change = findChange(after.board, "OV-103-C1")!.change;
    expect(change.pr).toEqual({
      number: 12,
      url: "https://github.com/example/repo/pull/12",
      state: "merged",
      head_sha: "3333333333333333333333333333333333333333",
      reviewed_sha: null,
    });
    // A merged pull request means the change is delivered, not under review.
    expect(change.state).toBe("done");
  });

  test("records an open pull request and puts the change in review", async () => {
    const boardPath = await writeStartedBoard();
    await updateChange(boardPath, "OV-103-C1", (change) => {
      change.state = "implementing";
    });

    const { code } = await runChangeCli(
      [
        "pr",
        "OV-103-C1",
        "--board",
        boardPath,
        "--base",
        "main",
        "--number",
        "12",
      ],
      {
        number: 12,
        url: "https://github.com/example/repo/pull/12",
        state: "OPEN",
        headRefOid: "4444444444444444444444444444444444444444",
        headRefName: "overlord/OV-103-C1",
      },
    );

    expect(code).toBe(0);
    const after = await loadBoard(boardPath);
    const change = findChange(after.board, "OV-103-C1")!.change;
    expect(change.pr!.number).toBe(12);
    expect(change.pr!.state).toBe("open");
    expect(change.state).toBe("reviewing");
  });

  test("leaves the change state alone for a closed pull request", async () => {
    const boardPath = await writeStartedBoard();
    await updateChange(boardPath, "OV-103-C1", (change) => {
      change.state = "implementing";
    });

    const { code } = await runChangeCli(
      [
        "pr",
        "OV-103-C1",
        "--board",
        boardPath,
        "--base",
        "main",
        "--number",
        "12",
      ],
      {
        number: 12,
        url: "https://github.com/example/repo/pull/12",
        state: "CLOSED",
        headRefOid: "5555555555555555555555555555555555555555",
        headRefName: "overlord/OV-103-C1",
      },
    );

    expect(code).toBe(0);
    const after = await loadBoard(boardPath);
    const change = findChange(after.board, "OV-103-C1")!.change;
    expect(change.pr!.state).toBe("closed");
    expect(change.state).toBe("implementing");
  });
});

describe("updateChanges", () => {
  test("writes every named change in a single board write", async () => {
    const boardPath = await writeSampleBoard();
    const before = await loadBoard(boardPath);

    const saves = await countSaves(() =>
      updateChanges(boardPath, ["OV-100-C1", "OV-103-C2"], (change) => {
        change.state = "done";
      }),
    );

    expect(saves).toBe(1);
    const after = await loadBoard(boardPath);
    expect(findChange(after.board, "OV-100-C1")!.change.state).toBe("done");
    expect(findChange(after.board, "OV-103-C2")!.change.state).toBe("done");

    // Changes and cards that were not named keep their previous content.
    expect(findChange(after.board, "OV-103-C1")!.change).toEqual(
      findChange(before.board, "OV-103-C1")!.change,
    );
    expect(after.board.items[1]!.next_action).toBe("start the first change");
    expect(after.board.items[1]!.updated_at).toBe("2026-08-02T00:00:00Z");
    expect(after.board.items[2]).toEqual(before.board.items[2]!);
    expect(after.board.items.length).toBe(before.board.items.length);
  });

  test("writes nothing at all for an empty id list", async () => {
    const boardPath = await writeSampleBoard();
    const before = await Bun.file(boardPath).text();

    const saves = await countSaves(() =>
      updateChanges(boardPath, [], () => {
        throw new Error("must not be called");
      }),
    );

    expect(saves).toBe(0);
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("re-reads and re-applies when the board changed after loading", async () => {
    const boardPath = await writeSampleBoard();
    let mutations = 0;

    const saves = await countSaves(() =>
      updateChanges(boardPath, ["OV-103-C1", "OV-103-C2"], (change) => {
        mutations += 1;
        // On the first pass, simulate a console write landing between the load
        // and the save, so the revision differs and the helper must re-read.
        if (mutations === 1) {
          const text = readFileSync(boardPath, "utf8").replace(
            '"start the first change"',
            '"written by the console while the CLI was running"',
          );
          writeFileSync(boardPath, text, "utf8");
        }
        change.state = "done";
      }),
    );

    // Two changes, applied once per change on each of the two passes.
    expect(mutations).toBe(4);
    expect(saves).toBe(1);
    const after = await loadBoard(boardPath);
    expect(findChange(after.board, "OV-103-C1")!.change.state).toBe("done");
    expect(findChange(after.board, "OV-103-C2")!.change.state).toBe("done");
    expect(after.board.items[1]!.next_action).toBe(
      "written by the console while the CLI was running",
    );
  });

  test("throws for an unknown change id and leaves the board byte-identical", async () => {
    const boardPath = await writeSampleBoard();
    const before = await Bun.file(boardPath).text();

    let thrown: unknown = null;
    const saves = await countSaves(async () => {
      try {
        await updateChanges(boardPath, ["OV-103-C1", "OV-999-C1"], (change) => {
          change.state = "done";
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(ChangeNotFoundError);
    expect(saves).toBe(0);
    expect(await Bun.file(boardPath).text()).toBe(before);
  });
});

function viewOf(overrides: Partial<PullRequestView> = {}): PullRequestView {
  return {
    number: 11,
    url: "https://github.com/o/r/pull/11",
    state: "OPEN",
    headRefOid: "a".repeat(40),
    ...overrides,
  };
}

function changeWithPr(overrides: Partial<Change> = {}): Change {
  return {
    id: "OV-200-C1",
    title: "A change with a pull request",
    state: "reviewing",
    branch: "overlord/OV-200-C1",
    pr: {
      number: 11,
      url: "https://github.com/o/r/pull/11",
      state: "open",
      head_sha: "a".repeat(40),
      reviewed_sha: null,
    },
    ...overrides,
  };
}

describe("applyPullRequestView", () => {
  test("a merged pull request also moves the change to done", () => {
    const change = changeWithPr();
    const outcome = applyPullRequestView(change, viewOf({ state: "MERGED" }));

    expect(change.pr!.state).toBe("merged");
    expect(change.state).toBe("done");
    expect(outcome).toEqual({
      changed: true,
      previousState: "open",
      state: "merged",
      changeDone: true,
    });
  });

  test("a closed pull request leaves the change state to the commander", () => {
    const change = changeWithPr();
    const outcome = applyPullRequestView(change, viewOf({ state: "CLOSED" }));

    expect(change.pr!.state).toBe("closed");
    expect(change.state).toBe("reviewing");
    expect(outcome.changed).toBe(true);
    expect(outcome.changeDone).toBe(false);
  });

  test("records the url and the head commit, and keeps reviewed_sha", () => {
    const change = changeWithPr({
      pr: {
        number: 11,
        url: null,
        state: "open",
        head_sha: "a".repeat(40),
        reviewed_sha: "0".repeat(40),
      },
    });
    const outcome = applyPullRequestView(
      change,
      viewOf({ headRefOid: "b".repeat(40) }),
    );

    expect(change.pr).toEqual({
      number: 11,
      url: "https://github.com/o/r/pull/11",
      state: "open",
      head_sha: "b".repeat(40),
      reviewed_sha: "0".repeat(40),
    });
    // A new head commit on an open pull request is a change worth writing.
    expect(outcome.changed).toBe(true);
    expect(outcome.changeDone).toBe(false);
  });

  test("reports no change when the pull request did not move", () => {
    const change = changeWithPr();
    const outcome = applyPullRequestView(change, viewOf());

    expect(outcome.changed).toBe(false);
    expect(change.state).toBe("reviewing");
  });

  test("is idempotent, so it can be re-applied after a board reload", () => {
    const change = changeWithPr();
    applyPullRequestView(change, viewOf({ state: "MERGED" }));
    const again = applyPullRequestView(change, viewOf({ state: "MERGED" }));

    expect(change.state).toBe("done");
    expect(again.changed).toBe(false);
    expect(again.changeDone).toBe(false);
  });

  test("the reported line names the transition", () => {
    expect(
      syncLine("OV-103-C2", {
        changed: true,
        previousState: "open",
        state: "merged",
        changeDone: true,
      }),
    ).toBe("OV-103-C2  open -> merged  (change done)");
    expect(
      syncLine("OV-103-C2", {
        changed: true,
        previousState: null,
        state: "open",
        changeDone: false,
      }),
    ).toBe("OV-103-C2  unknown -> open");
  });
});

describe("syncTargets", () => {
  test("takes only the changes that already carry a pull request number", () => {
    const targets = syncTargets([
      {
        id: "OV-200",
        title: "A card",
        state: "implementing",
        changes: [
          changeWithPr(),
          // Never pushed: nothing to ask GitHub about.
          {
            id: "OV-200-C2",
            title: "Not started",
            state: "specified",
            pr: null,
          },
          // Recorded but incomplete: still nothing to ask about.
          {
            id: "OV-200-C3",
            title: "No number",
            state: "implementing",
            pr: { url: null, state: null },
          },
        ],
      },
      { id: "OV-201", title: "No changes at all", state: "inbox" },
      {
        id: "OV-202",
        title: "Another card",
        state: "reviewing",
        changes: [changeWithPr({ id: "OV-202-C1" })],
      },
    ]);

    expect(targets.map((target) => target.change.id)).toEqual([
      "OV-200-C1",
      "OV-202-C1",
    ]);
    expect(targets.map((target) => target.item.id)).toEqual([
      "OV-200",
      "OV-202",
    ]);
    expect(targets[0]!.index).toBe(0);
  });

  test("takes nothing from a board where no change was pushed", () => {
    expect(syncTargets(sampleBoard().items)).toEqual([]);
  });
});

/**
 * A board with pull requests already recorded, so `sync` has something to
 * read: two changes under OV-200 plus one that was never pushed, and one
 * change under OV-201 that only `--all` reaches.
 */
function syncSampleBoard(): Board {
  return {
    version: 1,
    updated_at: "2026-08-01T00:00:00Z",
    items: [
      {
        id: "OV-200",
        title: "Card with pull requests",
        state: "implementing",
        next_action: "review the open changes",
        changes: [
          changeWithPr({ id: "OV-200-C1" }),
          changeWithPr({
            id: "OV-200-C2",
            branch: "overlord/OV-200-C2",
            pr: {
              number: 12,
              url: "https://github.com/o/r/pull/12",
              state: "open",
              head_sha: "b".repeat(40),
              reviewed_sha: null,
            },
          }),
          {
            id: "OV-200-C3",
            title: "Never pushed",
            state: "implementing",
            branch: "overlord/OV-200-C3",
            pr: null,
          },
        ],
      },
      {
        id: "OV-201",
        title: "Another card",
        state: "implementing",
        changes: [
          changeWithPr({
            id: "OV-201-C1",
            branch: "overlord/OV-201-C1",
            pr: {
              number: 21,
              url: "https://github.com/o/r/pull/21",
              state: "open",
              head_sha: "c".repeat(40),
              reviewed_sha: null,
            },
          }),
        ],
      },
    ],
  };
}

async function writeSyncBoard(): Promise<string> {
  const boardPath = join(await scratch(), "board.yaml");
  await saveBoard(boardPath, syncSampleBoard());
  return boardPath;
}

/**
 * A `gh` on PATH that answers from canned files and records its argument
 * vector, so the command under test is exercised end to end without talking
 * to GitHub. A pull request number with no canned answer fails, which is how
 * the failure path is driven.
 */
async function ghStub(
  answers: Record<number, Partial<PullRequestView>>,
): Promise<{ directory: string; log: string }> {
  const directory = await scratch();
  const log = join(directory, "gh.log");
  // Argument vector: gh pr view <number> --json <fields>
  const script = [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
    'if [ -f "$GH_STUB_DIR/$3.json" ]; then',
    '  cat "$GH_STUB_DIR/$3.json"',
    "  exit 0",
    "fi",
    'echo "no pull requests found for $3" >&2',
    "exit 1",
  ].join("\n");
  const executable = join(directory, "gh");
  await Bun.write(executable, `${script}\n`);
  chmodSync(executable, 0o755);
  for (const [number, answer] of Object.entries(answers)) {
    await Bun.write(
      join(directory, `${number}.json`),
      JSON.stringify(viewOf({ number: Number(number), ...answer })),
    );
  }
  return { directory, log };
}

/** Run `sync` with the stubbed `gh` first on PATH. */
async function runSync(
  argv: string[],
  stub: { directory: string; log: string },
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  saves: number;
  gh: string[];
}> {
  const previous = {
    path: process.env.PATH,
    dir: process.env.GH_STUB_DIR,
    log: process.env.GH_STUB_LOG,
  };
  process.env.PATH = `${stub.directory}:${previous.path ?? ""}`;
  process.env.GH_STUB_DIR = stub.directory;
  process.env.GH_STUB_LOG = stub.log;
  try {
    const before = saveCount;
    const result = await capture(() => sync(argv));
    const logged = await Bun.file(stub.log).exists();
    return {
      ...result,
      saves: saveCount - before,
      gh: logged
        ? (await Bun.file(stub.log).text()).split("\n").filter(Boolean)
        : [],
    };
  } finally {
    process.env.PATH = previous.path ?? "";
    if (previous.dir === undefined) delete process.env.GH_STUB_DIR;
    else process.env.GH_STUB_DIR = previous.dir;
    if (previous.log === undefined) delete process.env.GH_STUB_LOG;
    else process.env.GH_STUB_LOG = previous.log;
  }
}

describe("sync arguments", () => {
  test("--all is a flag and does not swallow the next argument", () => {
    expect(parseArgs(["--all", "--board", "/tmp/b.yaml"], ["all"])).toEqual({
      positional: [],
      options: { all: "true", board: "/tmp/b.yaml" },
    });
    expect(parseArgs(["OV-200", "--all"], ["all"])).toEqual({
      positional: ["OV-200"],
      options: { all: "true" },
    });
  });

  test("without a card id and without --all it prints the usage and exits 2", async () => {
    const boardPath = await writeSyncBoard();
    const before = await Bun.file(boardPath).text();

    const { code, stderr } = await captureStderr(() =>
      sync(["--board", boardPath]),
    );

    expect(code).toBe(2);
    expect(stderr).toContain("usage: change sync");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("a card id together with --all is refused", async () => {
    const boardPath = await writeSyncBoard();
    const before = await Bun.file(boardPath).text();

    const { code, stderr } = await captureStderr(() =>
      sync(["OV-200", "--all", "--board", boardPath]),
    );

    expect(code).toBe(2);
    expect(stderr).toContain("not both");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("an unknown card id fails without writing the board", async () => {
    const boardPath = await writeSyncBoard();
    const before = await Bun.file(boardPath).text();

    const { code, stderr } = await captureStderr(() =>
      sync(["OV-999", "--board", boardPath]),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("unknown card id: OV-999");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });
});

describe("sync", () => {
  test("reads every recorded pull request of one card and writes the board once", async () => {
    const boardPath = await writeSyncBoard();
    const stub = await ghStub({
      11: { state: "MERGED", headRefOid: "d".repeat(40) },
      12: { state: "CLOSED" },
    });

    const result = await runSync(["OV-200", "--board", boardPath], stub);

    expect(result.code).toBe(0);
    // One `gh pr view` per change that has a number; OV-200-C3 has no pull
    // request and OV-201-C1 belongs to another card, so neither is asked for.
    expect(result.gh).toEqual([
      "pr view 11 --json number,url,state,headRefOid,headRefName",
      "pr view 12 --json number,url,state,headRefOid,headRefName",
    ]);
    expect(result.saves).toBe(1);
    expect(result.stdout).toContain("OV-200-C1  open -> merged  (change done)");
    expect(result.stdout).toContain("OV-200-C2  open -> closed");
    expect(result.stdout).not.toContain("OV-200-C3");

    const after = await loadBoard(boardPath);
    const merged = findChange(after.board, "OV-200-C1")!.change;
    expect(merged.pr!.state).toBe("merged");
    expect(merged.pr!.head_sha).toBe("d".repeat(40));
    expect(merged.state).toBe("done");

    // A closed pull request is recorded, but the change state is left to the
    // commander.
    const closed = findChange(after.board, "OV-200-C2")!.change;
    expect(closed.pr!.state).toBe("closed");
    expect(closed.state).toBe("reviewing");

    // Nothing outside the two synchronized changes moved.
    const before = syncSampleBoard();
    expect(findChange(after.board, "OV-200-C3")!.change).toEqual(
      findChange(before, "OV-200-C3")!.change,
    );
    expect(findChange(after.board, "OV-201-C1")!.change).toEqual(
      findChange(before, "OV-201-C1")!.change,
    );
    expect(after.board.items[0]!.next_action).toBe("review the open changes");
  });

  test("--all reaches every card, still in a single board write", async () => {
    const boardPath = await writeSyncBoard();
    const stub = await ghStub({
      11: { state: "MERGED", headRefOid: "d".repeat(40) },
      12: { state: "CLOSED" },
      // Unchanged: same state, url and head commit as the board already has.
      21: {
        url: "https://github.com/o/r/pull/21",
        headRefOid: "c".repeat(40),
      },
    });

    const result = await runSync(["--all", "--board", boardPath], stub);

    expect(result.code).toBe(0);
    expect(result.gh.length).toBe(3);
    expect(result.gh[2]).toBe("pr view 21 --json number,url,state,headRefOid,headRefName");
    expect(result.saves).toBe(1);
    // The unchanged pull request is not reported.
    expect(result.stdout).not.toContain("OV-201-C1");

    const after = await loadBoard(boardPath);
    expect(findChange(after.board, "OV-200-C1")!.change.state).toBe("done");
    expect(findChange(after.board, "OV-201-C1")!.change).toEqual(
      findChange(syncSampleBoard(), "OV-201-C1")!.change,
    );
  });

  test("writes nothing when no pull request moved", async () => {
    const boardPath = await writeSyncBoard();
    const stub = await ghStub({
      21: {
        url: "https://github.com/o/r/pull/21",
        headRefOid: "c".repeat(40),
      },
    });
    const before = await Bun.file(boardPath).text();

    const result = await runSync(["OV-201", "--board", boardPath], stub);

    expect(result.code).toBe(0);
    expect(result.saves).toBe(0);
    expect(result.stdout).toContain("already current");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("a card whose changes were never pushed reads nothing", async () => {
    const boardPath = await writeSampleBoard();
    const stub = await ghStub({});
    const before = await Bun.file(boardPath).text();

    const result = await runSync(["OV-103", "--board", boardPath], stub);

    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.saves).toBe(0);
    expect(result.stdout).toContain("no change has a pull request to read");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("one failing pull request is skipped, the rest are still written", async () => {
    const boardPath = await writeSyncBoard();
    // No canned answer for 12, so the stub fails for that change only.
    const stub = await ghStub({
      11: { state: "MERGED", headRefOid: "d".repeat(40) },
    });

    const result = await runSync(["OV-200", "--board", boardPath], stub);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OV-200-C2: gh pr view 12 failed");
    expect(result.stderr).toContain("no pull requests found for 12");
    // The successful change is still recorded, in the one write of the run.
    expect(result.saves).toBe(1);
    expect(result.stdout).toContain("OV-200-C1  open -> merged");

    const after = await loadBoard(boardPath);
    expect(findChange(after.board, "OV-200-C1")!.change.state).toBe("done");
    expect(findChange(after.board, "OV-200-C2")!.change).toEqual(
      findChange(syncSampleBoard(), "OV-200-C2")!.change,
    );
  });
});
