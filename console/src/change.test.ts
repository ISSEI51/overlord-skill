import { afterAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as boardModule from "./board.ts";
import { resetAgentIdentityCache } from "./github-identity.ts";
import { loadBoard, saveBoard, type Board, type Change } from "./board.ts";
import {
  applyPullRequestView,
  branchNameFor,
  ChangeNotFoundError,
  changeStateForPr,
  checkOutcome,
  checkRollup,
  deliver,
  deliverCard,
  deliveryBodyFor,
  deliveryTitleFor,
  findChange,
  gh,
  git,
  identity,
  ItemNotFoundError,
  main,
  merge,
  mergeChange,
  mergeDeliveryBody,
  mergeRefusal,
  normalizePrState,
  parseArgs,
  parsePrNumber,
  parseSha,
  parseWorktreePaths,
  pr,
  prBodyFor,
  prTitleFor,
  resolveBoardPath,
  reviewed,
  reviewGapLine,
  run,
  RUN_FAILED,
  sameCommit,
  sync,
  syncLine,
  syncTargets,
  unmergedChanges,
  updateChange,
  updateChanges,
  updateItem,
  worktreePathFor,
  type MergeView,
  type PullRequestView,
} from "./change.ts";

/**
 * The tests below are about the behaviour with no agent account configured,
 * which is what CI runs with. A developer who exports `OVERLORD_GH_ACCOUNT`
 * for their own work must get the same results, so the variables are cleared
 * for this process; the cases that need an account set it themselves.
 */
delete process.env.OVERLORD_GH_ACCOUNT;
delete process.env.OVERLORD_GH_TOKEN;

/**
 * Count board writes.
 *
 * `sync` must write `board.yaml` once per run, whatever number of pull
 * requests it read, because every write makes the console re-render. The
 * counter sits on `mutateBoard`, which is the single write path the CLI uses;
 * `saveBoard` is called from inside board.ts and a wrapper on it would not be
 * seen. The real `mutateBoard` is kept and only wrapped, so every other test
 * keeps its exact behaviour and only the counter is added. A mutation that
 * throws never reaches the save, so it is not counted.
 */
const realMutateBoard = boardModule.mutateBoard;
let saveCount = 0;
mock.module("./board.ts", () => ({
  ...boardModule,
  mutateBoard: async <T>(
    path: string,
    expectedRev: string | null | undefined,
    mutate: (board: Board) => T | Promise<T>,
  ) => {
    const written = await realMutateBoard(path, expectedRev, mutate);
    saveCount += 1;
    return written;
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
  cwd: string = import.meta.dir,
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
      cwd,
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

describe("parseSha", () => {
  test("accepts a full object name and an abbreviation", () => {
    expect(parseSha("a".repeat(40))).toBe("a".repeat(40));
    expect(parseSha("1a2b3c4")).toBe("1a2b3c4");
    expect(parseSha("ABCDEF1")).toBe("abcdef1");
  });

  test("rejects anything that is not a commit name", () => {
    expect(parseSha("")).toBeNull();
    expect(parseSha("1a2b3c")).toBeNull(); // 6 digits: too short to be unique
    expect(parseSha("a".repeat(41))).toBeNull();
    expect(parseSha("HEAD")).toBeNull();
    expect(parseSha("overlord/OV-103-C4")).toBeNull();
    expect(parseSha("1a2b3c4 ")).toBeNull();
    expect(parseSha("g".repeat(40))).toBeNull();
  });
});

describe("sameCommit", () => {
  test("an abbreviation and the full object name are the same commit", () => {
    expect(sameCommit("1a2b3c4", "1a2b3c4d5e6f7890" + "0".repeat(24))).toBe(
      true,
    );
    expect(sameCommit("A".repeat(40), "a".repeat(40))).toBe(true);
  });

  test("different commits are different", () => {
    expect(sameCommit("a".repeat(40), "b".repeat(40))).toBe(false);
    expect(sameCommit("1a2b3c4", "9".repeat(40))).toBe(false);
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

/** Run a command in `cwd` and return its trimmed stdout, or throw. */
async function shell(command: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited ${code}: ${stderr || stdout}`);
  }
  return stdout.trim();
}

/**
 * A throwaway repository with one commit and a real change worktree at the
 * path `reviewed` looks for, so the worktree HEAD it records is a commit read
 * by real git rather than a stubbed value.
 */
async function repoWithWorktree(
  changeId: string,
): Promise<{ root: string; head: string }> {
  const root = await scratch();
  await shell(["git", "init", "--quiet", "--initial-branch=main", "."], root);
  await shell(
    [
      "git",
      "-c",
      "user.name=Overlord Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ],
    root,
  );
  const worktree = join(root, ".overlord/worktrees", changeId);
  await shell(
    ["git", "worktree", "add", "--quiet", worktree, "-b", `overlord/${changeId}`],
    root,
  );
  return { root, head: await shell(["git", "-C", worktree, "rev-parse", "HEAD"], root) };
}

/** A board whose OV-300-C1 is under review and already carries its own pr. */
function reviewBoard(): Board {
  return {
    version: 1,
    updated_at: "2026-08-01T00:00:00Z",
    items: [
      {
        id: "OV-300",
        title: "Card under review",
        state: "implementing",
        changes: [
          {
            id: "OV-300-C1",
            title: "The change under review",
            state: "reviewing",
            branch: "overlord/OV-300-C1",
            pr: {
              number: 30,
              url: "https://github.com/o/r/pull/30",
              state: "open",
              head_sha: "e".repeat(40),
              reviewed_sha: null,
            },
          },
          {
            id: "OV-300-C2",
            title: "Never pushed",
            state: "implementing",
            branch: "overlord/OV-300-C2",
            pr: null,
          },
        ],
      },
    ],
  };
}

async function writeReviewBoard(): Promise<string> {
  const boardPath = join(await scratch(), "board.yaml");
  await saveBoard(boardPath, reviewBoard());
  return boardPath;
}

/** The `gh pr view` answer for the pull request of OV-300-C1. */
const REVIEW_PR_VIEW = {
  number: 30,
  url: "https://github.com/o/r/pull/30",
  state: "OPEN",
  headRefOid: "f".repeat(40),
  headRefName: "overlord/OV-300-C1",
};

describe("reviewed", () => {
  test("rejects a --sha that is not a commit name, before touching the board", async () => {
    const boardPath = await writeReviewBoard();
    const before = await Bun.file(boardPath).text();

    for (const value of ["HEAD", "1a2b3c", "not-a-sha", "", "a".repeat(41)]) {
      const { code, stderr } = await captureStderr(() =>
        reviewed(["OV-300-C1", "--board", boardPath, "--sha", value]),
      );

      expect(code).toBe(2);
      expect(stderr).toContain("--sha must be a commit sha");
      expect(await Bun.file(boardPath).text()).toBe(before);
    }
  });

  test("records an explicit --sha and leaves the rest of the record alone", async () => {
    const boardPath = await writeReviewBoard();

    const { code, stderr } = await capture(() =>
      reviewed(["OV-300-C1", "--board", boardPath, "--sha", "1A2B3C4"]),
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    const after = await loadBoard(boardPath);
    const change = findChange(after.board, "OV-300-C1")!.change;
    expect(change.pr).toEqual({
      number: 30,
      url: "https://github.com/o/r/pull/30",
      state: "open",
      head_sha: "e".repeat(40),
      reviewed_sha: "1a2b3c4",
    });
    // Recording a review does not move the change; acceptance is not automatic.
    expect(change.state).toBe("reviewing");
  });

  test("fails without writing the board when the change has no pull request", async () => {
    const boardPath = await writeReviewBoard();
    const before = await Bun.file(boardPath).text();

    const { code, stderr } = await captureStderr(() =>
      reviewed(["OV-300-C2", "--board", boardPath, "--sha", "a".repeat(40)]),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("has no pull request on the board");
    expect(stderr).toContain("change pr OV-300-C2");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("fails without writing the board for an unknown change id", async () => {
    const boardPath = await writeReviewBoard();
    const before = await Bun.file(boardPath).text();

    const { code, stderr } = await captureStderr(() =>
      reviewed(["OV-999-C1", "--board", boardPath, "--sha", "a".repeat(40)]),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("unknown change id: OV-999-C1");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("records the HEAD of the change worktree by default", async () => {
    const repo = await repoWithWorktree("OV-300-C1");
    const boardPath = await writeReviewBoard();

    // The stub answers a different commit, so a run that recorded the pull
    // request head instead of the worktree HEAD would be visible here.
    const { code, stdout, stderr } = await runChangeCli(
      ["reviewed", "OV-300-C1", "--board", boardPath],
      REVIEW_PR_VIEW,
      repo.root,
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain(repo.head);
    expect(stdout).toContain(join(repo.root, ".overlord/worktrees/OV-300-C1"));

    const after = await loadBoard(boardPath);
    const change = findChange(after.board, "OV-300-C1")!.change;
    expect(change.pr!.reviewed_sha).toBe(repo.head);
    expect(change.pr!.head_sha).toBe("e".repeat(40));
    expect(change.pr!.number).toBe(30);
  });

  test("falls back to the pull request head when the worktree is gone", async () => {
    // A repository with a worktree for another change, so the lookup for
    // OV-300-C1 finds nothing and the pull request is read instead.
    const repo = await repoWithWorktree("OV-300-C9");
    const boardPath = await writeReviewBoard();

    const { code, stdout, stderr } = await runChangeCli(
      ["reviewed", "OV-300-C1", "--board", boardPath],
      REVIEW_PR_VIEW,
      repo.root,
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("gh pr view 30");

    const after = await loadBoard(boardPath);
    expect(findChange(after.board, "OV-300-C1")!.change.pr!.reviewed_sha).toBe(
      "f".repeat(40),
    );
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

/**
 * A `gh pr view` answer for the canned pull request #11.
 *
 * `headRefName` is part of `PullRequestView` and both `pr` and `sync` refuse a
 * pull request that is not on the change's branch, so the default has to be the
 * branch of the change that owns #11 on the sample boards below; a test that
 * needs a mismatch overrides it.
 */
function viewOf(overrides: Partial<PullRequestView> = {}): PullRequestView {
  return {
    number: 11,
    url: "https://github.com/o/r/pull/11",
    state: "OPEN",
    headRefOid: "a".repeat(40),
    headRefName: "overlord/OV-200-C1",
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

describe("reviewGapLine", () => {
  test("warns when the pull request grew commits after the review", () => {
    expect(reviewGapLine("OV-200-C1", "b".repeat(40), "a".repeat(40))).toBe(
      `OV-200-C1: commits were added after the review ` +
        `(reviewed ${"a".repeat(40)}, head ${"b".repeat(40)}); ` +
        `review the new commits before merging`,
    );
  });

  test("is quiet when the reviewed commit is the head commit", () => {
    expect(reviewGapLine("OV-200-C1", "a".repeat(40), "a".repeat(40))).toBeNull();
    // An abbreviation recorded by `reviewed --sha` is not a review gap.
    expect(reviewGapLine("OV-200-C1", "abc1234" + "0".repeat(33), "abc1234")).toBeNull();
  });

  test("is quiet while either commit is unknown", () => {
    expect(reviewGapLine("OV-200-C1", "a".repeat(40), null)).toBeNull();
    expect(reviewGapLine("OV-200-C1", null, "a".repeat(40))).toBeNull();
    expect(reviewGapLine("OV-200-C1", undefined, undefined)).toBeNull();
    expect(reviewGapLine("OV-200-C1", "", "")).toBeNull();
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

/**
 * The branch each canned pull request of `syncSampleBoard` is on. `sync` reads
 * `headRefName` and skips a pull request that is on any other branch, so the
 * stub has to answer with the branch the board records for that change.
 */
const SYNC_BRANCHES: Record<number, string> = {
  11: "overlord/OV-200-C1",
  12: "overlord/OV-200-C2",
  21: "overlord/OV-201-C1",
};

async function writeSyncBoard(): Promise<string> {
  const boardPath = join(await scratch(), "board.yaml");
  await saveBoard(boardPath, syncSampleBoard());
  return boardPath;
}

/** The sync sample board with `reviewed_sha` recorded on one change. */
async function writeReviewedSyncBoard(
  changeId: string,
  reviewedSha: string,
): Promise<string> {
  const board = syncSampleBoard();
  findChange(board, changeId)!.change.pr!.reviewed_sha = reviewedSha;
  const boardPath = join(await scratch(), "board.yaml");
  await saveBoard(boardPath, board);
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
      JSON.stringify(
        viewOf({
          number: Number(number),
          headRefName: SYNC_BRANCHES[Number(number)],
          ...answer,
        }),
      ),
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

  test("a pull request on another branch is skipped and never written", async () => {
    const boardPath = await writeSyncBoard();
    const stub = await ghStub({
      // What a wrong `pr.number` produces: a real pull request, on a branch
      // that has nothing to do with this change. It used to be recorded, with
      // its merged state moving the change to done, and the run still exited 0.
      11: {
        state: "MERGED",
        headRefOid: "d".repeat(40),
        headRefName: "totally/unrelated-branch",
      },
      12: { state: "CLOSED" },
    });

    const result = await runSync(["OV-200", "--board", boardPath], stub);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OV-200-C1: pull request #11 is on branch");
    expect(result.stderr).toContain("totally/unrelated-branch");
    expect(result.stderr).toContain("overlord/OV-200-C1");
    expect(result.stdout).not.toContain("OV-200-C1");

    // The sibling change is still synchronized, in the one write of the run.
    expect(result.saves).toBe(1);
    expect(result.stdout).toContain("OV-200-C2  open -> closed");

    const after = await loadBoard(boardPath);
    expect(findChange(after.board, "OV-200-C1")!.change).toEqual(
      findChange(syncSampleBoard(), "OV-200-C1")!.change,
    );
  });

  test("a run where nothing could be read does not claim the board is current", async () => {
    const boardPath = await writeSyncBoard();
    const stub = await ghStub({
      21: { headRefName: "someone-elses-branch" },
    });
    const before = await Bun.file(boardPath).text();

    const result = await runSync(["OV-201", "--board", boardPath], stub);

    expect(result.code).toBe(1);
    expect(result.saves).toBe(0);
    expect(result.stdout).not.toContain("already current");
    expect(result.stdout).toContain("could not be read");
    expect(result.stdout).toContain("not known to be current");
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("commits added after the review are reported, and the run still succeeds", async () => {
    const boardPath = await writeReviewedSyncBoard("OV-201-C1", "c".repeat(40));
    const stub = await ghStub({
      // A new head commit on the pull request that was reviewed at c...c.
      21: {
        url: "https://github.com/o/r/pull/21",
        headRefOid: "e".repeat(40),
      },
    });

    const result = await runSync(["OV-201", "--board", boardPath], stub);

    // A warning, not a failure: the merge gate is the commander's call.
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "OV-201-C1: commits were added after the review",
    );
    expect(result.stderr).toContain("e".repeat(40));
    expect(result.saves).toBe(1);

    const after = await loadBoard(boardPath);
    const change = findChange(after.board, "OV-201-C1")!.change;
    expect(change.pr!.head_sha).toBe("e".repeat(40));
    expect(change.pr!.reviewed_sha).toBe("c".repeat(40));
  });

  test("the review gap is reported even when the pull request did not move", async () => {
    const boardPath = await writeReviewedSyncBoard("OV-201-C1", "9".repeat(40));
    const stub = await ghStub({
      21: {
        url: "https://github.com/o/r/pull/21",
        headRefOid: "c".repeat(40),
      },
    });

    const result = await runSync(["OV-201", "--board", boardPath], stub);

    expect(result.code).toBe(0);
    expect(result.saves).toBe(0);
    expect(result.stdout).toContain("already current");
    expect(result.stderr).toContain(
      "OV-201-C1: commits were added after the review",
    );
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

/**
 * Cross-process serialization (OV-104-C2).
 *
 * Before the `<board>.lock`, the CLI's `updateChange` and a console write
 * raced: measured at 0 conflicts reported in 750 rounds, 2-3% of CLI writes
 * lost, 17-49% of console writes rolled back, and 92-97% of concurrent write
 * pairs failing with `rename ENOENT` on the shared staging file. Both writers
 * now go through `mutateBoard`, so they take the same lock.
 */
const CLI_WRITER_SOURCE = `
const [modulePath, boardPath, changeId, tag, roundsRaw] = Bun.argv.slice(2);
const { updateChange } = await import(modulePath);
const rounds = Number(roundsRaw);
const failures = [];
const errors = [];
for (let round = 0; round < rounds; round += 1) {
  try {
    await updateChange(boardPath, changeId, (change) => {
      change.branch = \`\${tag}-\${round}\`;
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

/** A console-style writer: the server's own write path, on another card. */
const CONSOLE_WRITER_SOURCE = `
const [modulePath, boardPath, itemId, tag, roundsRaw] = Bun.argv.slice(2);
const { mutateBoard } = await import(modulePath);
const rounds = Number(roundsRaw);
const failures = [];
const errors = [];
for (let round = 0; round < rounds; round += 1) {
  try {
    await mutateBoard(boardPath, undefined, (board) => {
      const item = board.items.find((entry) => entry.id === itemId);
      if (!item) throw new Error("card vanished from the board: " + itemId);
      item.next_action = \`\${tag}-\${round}\`;
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

describe("cross-process writes from the CLI and the console", () => {
  test(
    "100 interleaved rounds: no ENOENT, no corruption, neither writer is lost",
    async () => {
      const boardPath = await writeSampleBoard();
      const dir = resolve(boardPath, "..");
      const cliScript = join(dir, "cli-writer.ts");
      const consoleScript = join(dir, "console-writer.ts");
      writeFileSync(cliScript, CLI_WRITER_SOURCE, "utf8");
      writeFileSync(consoleScript, CONSOLE_WRITER_SOURCE, "utf8");
      const rounds = 100;
      const changeModule = join(import.meta.dir, "change.ts");
      const boardModule = join(import.meta.dir, "board.ts");

      const children = [
        Bun.spawn(
          ["bun", "run", cliScript, changeModule, boardPath, "OV-103-C1", "cli", String(rounds)],
          { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
        ),
        Bun.spawn(
          ["bun", "run", consoleScript, boardModule, boardPath, "OV-100", "console", String(rounds)],
          { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
        ),
      ];

      const reports: { tag: string; failures: number[]; errors: string[] }[] = [];
      for (const child of children) {
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        expect(stderr).toBe("");
        expect(await child.exited).toBe(0);
        reports.push(JSON.parse(stdout));
      }

      // No `rename ENOENT` and no other unexpected failure on either side.
      for (const report of reports) expect(report.errors).toEqual([]);
      // Short writes never wait out the 5 s acquire timeout, so nothing is
      // even reported as a conflict.
      for (const report of reports) expect(report.failures).toEqual([]);

      // The board still parses and both writers' last value survived: the
      // CLI did not roll the console's card back, and the console did not
      // drop the CLI's change.
      const after = await loadBoard(boardPath);
      expect(after.board.version).toBe(1);
      expect(findChange(after.board, "OV-103-C1")!.change.branch).toBe(
        `cli-${rounds - 1}`,
      );
      expect(after.board.items.find((entry) => entry.id === "OV-100")!.next_action).toBe(
        `console-${rounds - 1}`,
      );
      // Untouched cards are intact, so no partial write landed.
      expect(findChange(after.board, "OV-103-C2")!.change).toEqual(
        findChange(sampleBoard(), "OV-103-C2")!.change,
      );
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// deliver (OV-105-C1)
// ---------------------------------------------------------------------------

/** Run a git command in `cwd`, with an identity and no signing. */
function gitIn(args: string[], cwd: string): Promise<string> {
  return shell(
    [
      "git",
      "-c",
      "user.name=Overlord Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
  );
}

/**
 * A throwaway repository with a real `origin`, so `deliverCard` pushes, fetches
 * and diffs against something that exists instead of a stub.
 *
 * Branches: `main` (the default branch, also `origin/HEAD`), `same` pointing at
 * the same commit as `main`, and `feature`, checked out, with one commit of its
 * own. `feature` is what a delivery proposes; `same` is what a branch that has
 * nothing left to deliver looks like.
 */
async function deliveryRepo(): Promise<{ root: string; origin: string }> {
  const origin = await scratch();
  await gitIn(["init", "--quiet", "--bare", "--initial-branch=main", "."], origin);

  const root = await scratch();
  await gitIn(["init", "--quiet", "--initial-branch=main", "."], root);
  await Bun.write(join(root, "README.md"), "base\n");
  await gitIn(["add", "-A"], root);
  await gitIn(["commit", "--quiet", "-m", "init"], root);
  await gitIn(["remote", "add", "origin", origin], root);
  await gitIn(["push", "--quiet", "-u", "origin", "main"], root);
  await gitIn(
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    root,
  );

  await gitIn(["branch", "same", "main"], root);
  await gitIn(["checkout", "--quiet", "-b", "feature"], root);
  await Bun.write(join(root, "feature.txt"), "work\n");
  await gitIn(["add", "-A"], root);
  await gitIn(["commit", "--quiet", "-m", "feature work"], root);

  return { root, origin };
}

/**
 * Commit `content` to `file` on `main` and push it, so `origin/main` really is
 * ahead of `feature` — what the default branch looks like when something else
 * landed on it while the card was in flight.
 *
 * Leaves `feature` checked out, which is where `deliveryRepo` left the
 * repository.
 */
async function advanceBase(
  root: string,
  file: string,
  content: string,
): Promise<void> {
  await gitIn(["checkout", "--quiet", "main"], root);
  await Bun.write(join(root, file), content);
  await gitIn(["add", "-A"], root);
  await gitIn(["commit", "--quiet", "-m", `main moved on: ${file}`], root);
  await gitIn(["push", "--quiet", "origin", "main"], root);
  await gitIn(["checkout", "--quiet", "feature"], root);
}

/**
 * Merge `feature` into `main` with `--no-ff` and push it, so `origin/main` is
 * ahead of `feature` by the merge commit while the two trees stay identical —
 * a card whose work already landed, on a branch nobody deleted yet.
 *
 * Leaves `feature` checked out, which is where `deliveryRepo` left the
 * repository.
 */
async function mergeHeadIntoBase(root: string): Promise<void> {
  await gitIn(["checkout", "--quiet", "main"], root);
  await gitIn(
    ["merge", "--quiet", "--no-ff", "-m", "merge feature", "feature"],
    root,
  );
  await gitIn(["push", "--quiet", "origin", "main"], root);
  await gitIn(["checkout", "--quiet", "feature"], root);
}

/**
 * Add a branch with a history of its own — a root commit with an empty tree,
 * built with plumbing so the working tree is left alone — and push it, so
 * `origin/<name>` shares no commit with `feature`.
 *
 * This is what a `--base` naming another repository's branch looks like, and
 * the one way a delivery can make `git merge-tree` refuse the merge outright.
 */
async function unrelatedBase(root: string, name: string): Promise<void> {
  const tree = await gitIn(["hash-object", "-w", "-t", "tree", "/dev/null"], root);
  const commit = await gitIn(["commit-tree", tree, "-m", "unrelated root"], root);
  await gitIn(["branch", name, commit], root);
  await gitIn(["push", "--quiet", "origin", name], root);
}

/**
 * Commit `count` files on `feature`, then a different version of each of them
 * on `main`, so merging the two conflicts in every one of them.
 *
 * The names are zero-padded so their lexical order — the order
 * `git merge-tree --name-only` prints them in — is their numeric order.
 */
async function conflictingFiles(root: string, count: number): Promise<string[]> {
  const paths = Array.from(
    { length: count },
    (_, index) => `conflict-${String(index + 1).padStart(2, "0")}.txt`,
  );
  for (const path of paths) await Bun.write(join(root, path), "from the card\n");
  await gitIn(["add", "-A"], root);
  await gitIn(["commit", "--quiet", "-m", "the card writes every file"], root);

  await gitIn(["checkout", "--quiet", "main"], root);
  for (const path of paths) await Bun.write(join(root, path), "from main\n");
  await gitIn(["add", "-A"], root);
  await gitIn(["commit", "--quiet", "-m", "main writes every file"], root);
  await gitIn(["push", "--quiet", "origin", "main"], root);
  await gitIn(["checkout", "--quiet", "feature"], root);
  return paths;
}

/**
 * A `git` on PATH that answers any invocation carrying `subcommand` from a
 * canned exit code and canned streams, and hands every other invocation to the
 * real `git`.
 *
 * `git merge-tree` reports a conflict with exit 1 and the merged tree on
 * stdout, and reports a merge it could not attempt with exit 1 as well when a
 * ref does not resolve, so the exit code alone cannot separate the two and
 * `baseGapWarnings` reads stdout instead. That combination — exit 1 with
 * nothing on stdout — cannot be built out of a repository on the delivery path,
 * because a ref the delivery already diffed against resolves for `merge-tree`
 * too, so it is injected here.
 */
async function gitStub(
  subcommand: string,
  answer: { code: number; stdout?: string; stderr?: string },
): Promise<{ dir: string }> {
  const dir = await scratch();
  const real = await shell(["/bin/sh", "-c", "command -v git"], dir);
  // The streams go through files rather than through the script, so what the
  // stub writes is byte for byte what the test asked for.
  const out = join(dir, "stdout");
  const err = join(dir, "stderr");
  await Bun.write(out, answer.stdout ?? "");
  await Bun.write(err, answer.stderr ?? "");
  const script = [
    "#!/bin/sh",
    'for argument in "$@"; do',
    `  if [ "$argument" = ${JSON.stringify(subcommand)} ]; then`,
    `    cat ${JSON.stringify(out)}`,
    `    cat ${JSON.stringify(err)} >&2`,
    `    exit ${answer.code}`,
    "  fi",
    "done",
    `exec ${JSON.stringify(real)} "$@"`,
    "",
  ].join("\n");
  const executable = join(dir, "git");
  await Bun.write(executable, script);
  chmodSync(executable, 0o755);
  return { dir };
}

/** Run `body` with `stub` first on PATH, so its `git` shadows the real one. */
async function withGitStub<T>(
  stub: { dir: string },
  body: () => Promise<T>,
): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${stub.dir}:${previous ?? ""}`;
  try {
    return await body();
  } finally {
    process.env.PATH = previous ?? "";
  }
}

/** US, the ASCII unit separator: what the `gh` stub joins its argv with. */
const ARG_SEPARATOR = "\u001f";

/**
 * A `gh` on PATH for the delivery commands.
 *
 * It answers from canned files and records every argument vector, so what the
 * command did to GitHub can be asserted exactly — including what it did *not*
 * do, which is the point of the blocked and the idempotency tests. The vector
 * is written base64-encoded because a pull request body contains newlines and
 * would otherwise be indistinguishable from further calls.
 *
 * A subcommand with no canned file fails, so an unexpected `gh` call is a test
 * failure rather than a silent success.
 */
async function deliverGhStub(
  answers: Record<string, unknown>,
): Promise<{ dir: string; log: string }> {
  const dir = await scratch();
  const log = join(dir, "gh.log");
  const script = [
    "#!/bin/sh",
    `printf '%s\\037' "$@" | base64 | tr -d '\\n' >> "$GH_STUB_LOG"`,
    `printf '\\n' >> "$GH_STUB_LOG"`,
    'f=""',
    'case "$1 $2" in',
    '  "pr list") f="pr-list.json" ;;',
    '  "pr create") f="pr-create.txt" ;;',
    '  "pr edit") f="pr-edit.txt" ;;',
    '  "repo view") f="repo-view.json" ;;',
    '  "pr view")',
    '    case "$*" in',
    '      *"--json body"*) f="body-$3.json" ;;',
    '      *) f="view-$3.json" ;;',
    "    esac",
    "    ;;",
    "esac",
    'if [ -n "$f" ] && [ -f "$GH_STUB_DIR/$f" ]; then',
    '  cat "$GH_STUB_DIR/$f"',
    "  exit 0",
    "fi",
    'echo "stub gh: no canned answer for: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  const executable = join(dir, "gh");
  await Bun.write(executable, script);
  chmodSync(executable, 0o755);

  for (const [name, value] of Object.entries(answers)) {
    await Bun.write(
      join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  return { dir, log };
}

/** Every `gh` argument vector the stub recorded, in call order. */
async function ghCalls(stub: { log: string }): Promise<string[][]> {
  if (!(await Bun.file(stub.log).exists())) return [];
  return (await Bun.file(stub.log).text())
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      Buffer.from(line, "base64").toString("utf8").split(ARG_SEPARATOR).slice(0, -1),
    );
}

/** Run `body` with the stubbed `gh` first on PATH. */
async function withGhStub<T>(
  stub: { dir: string; log: string },
  body: () => Promise<T>,
): Promise<T> {
  const previous = {
    path: process.env.PATH,
    dir: process.env.GH_STUB_DIR,
    log: process.env.GH_STUB_LOG,
  };
  process.env.PATH = `${stub.dir}:${previous.path ?? ""}`;
  process.env.GH_STUB_DIR = stub.dir;
  process.env.GH_STUB_LOG = stub.log;
  try {
    return await body();
  } finally {
    process.env.PATH = previous.path ?? "";
    if (previous.dir === undefined) delete process.env.GH_STUB_DIR;
    else process.env.GH_STUB_DIR = previous.dir;
    if (previous.log === undefined) delete process.env.GH_STUB_LOG;
    else process.env.GH_STUB_LOG = previous.log;
  }
}

const MERGED_CHANGE: Change = {
  id: "OV-500-C1",
  title: "The merged change",
  state: "done",
  branch: "overlord/OV-500-C1",
  pr: {
    number: 50,
    url: "https://github.com/o/r/pull/50",
    state: "merged",
    head_sha: "a".repeat(40),
    reviewed_sha: "a".repeat(40),
  },
};

/** The `gh pr view 50` answer that leaves MERGED_CHANGE exactly as it is. */
const VIEW_50_UNCHANGED = {
  number: 50,
  url: "https://github.com/o/r/pull/50",
  state: "MERGED",
  headRefOid: "a".repeat(40),
  headRefName: "overlord/OV-500-C1",
};

const OPEN_CHANGE: Change = {
  id: "OV-500-C2",
  title: "The open change",
  state: "reviewing",
  branch: "overlord/OV-500-C2",
  pr: {
    number: 51,
    url: "https://github.com/o/r/pull/51",
    state: "open",
    head_sha: "b".repeat(40),
    reviewed_sha: "b".repeat(40),
  },
};

/** The `gh pr view 51` answer that leaves OPEN_CHANGE open. */
const VIEW_51_OPEN = {
  number: 51,
  url: "https://github.com/o/r/pull/51",
  state: "OPEN",
  headRefOid: "b".repeat(40),
  headRefName: "overlord/OV-500-C2",
};

/** The delivery pull request the stub reports for the `feature` branch. */
const DELIVERY_VIEW = {
  number: 99,
  url: "https://github.com/o/r/pull/99",
  state: "OPEN",
  headRefOid: "c".repeat(40),
  headRefName: "feature",
  baseRefName: "main",
};

function deliveryBoardWith(changes: Change[]): Board {
  return {
    version: 1,
    updated_at: "2026-08-01T00:00:00Z",
    items: [
      {
        id: "OV-500",
        title: "A card to deliver",
        state: "acceptance",
        acceptance_conditions: [
          "The delivery pull request names the card",
          "Nothing unmerged is delivered",
        ],
        next_action: "deliver",
        changes,
      },
      { id: "OV-501", title: "An untouched card", state: "inbox" },
    ],
  };
}

async function writeDeliveryBoard(changes: Change[]): Promise<string> {
  const boardPath = join(await scratch(), "board.yaml");
  await saveBoard(boardPath, deliveryBoardWith(changes));
  return boardPath;
}

describe("delivery text", () => {
  test("the title is the card title with its id appended", () => {
    const item = deliveryBoardWith([MERGED_CHANGE]).items[0]!;
    expect(deliveryTitleFor(item)).toBe("A card to deliver (OV-500)");
  });

  test("the body names the card, its acceptance conditions and its changes", () => {
    const item = deliveryBoardWith([MERGED_CHANGE]).items[0]!;
    const body = deliveryBodyFor(item);

    expect(body).toContain("A card to deliver");
    expect(body).toContain("Card: OV-500");
    expect(body).toContain("- The delivery pull request names the card");
    expect(body).toContain("- Nothing unmerged is delivered");
    expect(body).toContain(
      "- OV-500-C1  The merged change  (done)  #50 https://github.com/o/r/pull/50",
    );
  });

  test("a change with no pull request is listed as having none", () => {
    const item = deliveryBoardWith([
      { id: "OV-500-C9", title: "Never pushed", state: "done", pr: null },
    ]).items[0]!;
    expect(deliveryBodyFor(item)).toContain(
      "- OV-500-C9  Never pushed  (done)  PR 無し",
    );
  });

  test("a card with no conditions and no changes still produces a body", () => {
    const body = deliveryBodyFor({
      id: "OV-502",
      title: "Bare card",
      state: "acceptance",
    });
    expect(body).toContain("Card: OV-502");
    expect(body.match(/- \(board に記録なし\)/g)?.length).toBe(2);
  });
});

describe("mergeDeliveryBody", () => {
  test("appends a fenced section to a body that has none", () => {
    const merged = mergeDeliveryBody("Written by hand.", "OV-500", "the section");
    expect(merged).toBe(
      "Written by hand.\n\n" +
        "<!-- overlord:card OV-500 -->\nthe section\n<!-- /overlord:card OV-500 -->\n",
    );
  });

  test("an empty body becomes the section alone", () => {
    expect(mergeDeliveryBody("", "OV-500", "the section")).toBe(
      "<!-- overlord:card OV-500 -->\nthe section\n<!-- /overlord:card OV-500 -->\n",
    );
    expect(mergeDeliveryBody(null, "OV-500", "s")).toContain("overlord:card OV-500");
    expect(mergeDeliveryBody(undefined, "OV-500", "s")).toContain(
      "<!-- /overlord:card OV-500 -->",
    );
  });

  test("replaces this card's section and leaves everything else alone", () => {
    const existing = [
      "Written by hand, above.",
      "",
      "<!-- overlord:card OV-499 -->",
      "another card's section",
      "<!-- /overlord:card OV-499 -->",
      "",
      "<!-- overlord:card OV-500 -->",
      "the old section",
      "<!-- /overlord:card OV-500 -->",
      "",
      "Written by hand, below.",
      "",
    ].join("\n");

    const merged = mergeDeliveryBody(existing, "OV-500", "the new section");

    expect(merged).toContain("Written by hand, above.");
    expect(merged).toContain("Written by hand, below.");
    expect(merged).toContain("another card's section");
    expect(merged).toContain("the new section");
    expect(merged).not.toContain("the old section");
    // Exactly one section per card, however often the card is delivered.
    expect(merged.match(/<!-- overlord:card OV-500 -->/g)!.length).toBe(1);
    expect(merged.match(/<!-- overlord:card OV-499 -->/g)!.length).toBe(1);
    expect(mergeDeliveryBody(merged, "OV-500", "the new section")).toBe(merged);
  });

  test("an opening marker with no closing marker is left in place", () => {
    // Truncated by hand: replacing to the end of the body would delete text the
    // person wrote after it, so the section is appended instead.
    const existing = "<!-- overlord:card OV-500 -->\nhalf a section\nmore text";
    const merged = mergeDeliveryBody(existing, "OV-500", "the new section");
    expect(merged).toContain("half a section");
    expect(merged).toContain("more text");
    expect(merged).toContain("the new section");
  });
});

describe("unmergedChanges", () => {
  test("takes every change that is not done", () => {
    const item = deliveryBoardWith([
      MERGED_CHANGE,
      OPEN_CHANGE,
      { id: "OV-500-C3", title: "Blocked", state: "blocked" },
    ]).items[0]!;
    expect(unmergedChanges(item).map((change) => change.id)).toEqual([
      "OV-500-C2",
      "OV-500-C3",
    ]);
  });

  test("a card whose changes are all done, or which has none, has nothing unmerged", () => {
    expect(unmergedChanges(deliveryBoardWith([MERGED_CHANGE]).items[0]!)).toEqual([]);
    expect(unmergedChanges({ id: "OV-1", title: "t", state: "inbox" })).toEqual([]);
  });
});

describe("updateItem", () => {
  test("writes the target card and leaves every other card alone", async () => {
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const before = await loadBoard(boardPath);

    await updateItem(boardPath, "OV-500", (item) => {
      item.delivery = {
        branch: "feature",
        base: "main",
        pr: null,
        error: null,
        attempted_at: "2026-08-02T00:00:00Z",
      };
    });

    const after = await loadBoard(boardPath);
    expect(after.board.items[0]!.delivery).toEqual({
      branch: "feature",
      base: "main",
      pr: null,
      error: null,
      attempted_at: "2026-08-02T00:00:00Z",
    });
    expect(after.board.items[0]!.next_action).toBe("deliver");
    expect(findChange(after.board, "OV-500-C1")!.change).toEqual(
      findChange(before.board, "OV-500-C1")!.change,
    );
    expect(after.board.items[1]).toEqual(before.board.items[1]!);
  });

  test("throws for an unknown card id and leaves the board byte-identical", async () => {
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const before = await Bun.file(boardPath).text();

    let thrown: unknown = null;
    const saves = await countSaves(async () => {
      try {
        await updateItem(boardPath, "OV-999", (item) => {
          item.owner = "nobody";
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(ItemNotFoundError);
    expect(saves).toBe(0);
    expect(await Bun.file(boardPath).text()).toBe(before);
  });
});

describe("run", () => {
  test("a command that outruns its timeout is killed and reported, not awaited", async () => {
    const started = Date.now();
    const result = await run(["sleep", "10"], undefined, 150);

    expect(result.code).toBe(RUN_FAILED);
    expect(result.stderr).toContain("timed out after 150ms");
    // The point of the timeout: the caller is not held for the full 10 s.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a command whose children hold the pipes is still cut off on time", async () => {
    // `git push` starts `git-remote-https` or `ssh`, which inherit its pipes.
    // Killing the command alone left `run` waiting for those pipes to close,
    // so a 1 s timeout took 10.4 s of real time on a `sh` that had started a
    // `sleep 10`; the console server has no user to interrupt it.
    const started = Date.now();
    const result = await run(["/bin/sh", "-c", "sleep 10 & wait"], undefined, 300);

    expect(result.code).toBe(RUN_FAILED);
    expect(result.stderr).toContain("timed out after 300ms");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a missing executable is a result, not a synchronous throw", async () => {
    const result = await run(["overlord-no-such-executable-xyz"]);

    expect(result.code).toBe(RUN_FAILED);
    expect(result.stderr).toContain("overlord-no-such-executable-xyz");
    expect(result.stdout).toBe("");
  });

  test("a command that finishes inside its timeout is unaffected", async () => {
    const result = await run(["echo", "delivered"], undefined, 10_000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("delivered");
  });
});

describe("deliverCard", () => {
  test("(a) a card whose changes are all merged gets a new pull request", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "https://github.com/o/r/pull/99\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.warnings).toEqual([]);
    expect(outcome.status).toBe("created");
    expect(outcome.pr).toEqual({
      number: 99,
      url: "https://github.com/o/r/pull/99",
      state: "open",
      head_sha: "c".repeat(40),
      reviewed_sha: null,
    });

    const calls = await ghCalls(stub);
    expect(calls.map((call) => call.slice(0, 2).join(" "))).toEqual([
      "pr view",
      "pr list",
      "pr create",
      "pr view",
    ]);
    expect(calls[1]).toEqual([
      "pr",
      "list",
      "--head",
      "feature",
      "--base",
      "main",
      "--state",
      "open",
      "--json",
      "number,url",
    ]);
    // The base was resolved from origin/HEAD, so gh was never asked for it.
    expect(calls.some((call) => call[0] === "repo")).toBe(false);

    const created = calls[2]!;
    expect(created.slice(0, 7)).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "feature",
      "--title",
    ]);
    expect(created[7]).toBe("A card to deliver (OV-500)");
    expect(created[8]).toBe("--body");
    expect(created[9]).toContain("<!-- overlord:card OV-500 -->");
    expect(created[9]).toContain("Card: OV-500");
    expect(created[9]).toContain("- OV-500-C1  The merged change  (done)  #50");
    expect(created[9]).toContain("<!-- /overlord:card OV-500 -->");

    // The branch really was pushed, so the pull request has something to show.
    expect(await shell(["git", "rev-parse", "origin/feature"], repo.root)).toBe(
      await shell(["git", "rev-parse", "feature"], repo.root),
    );

    const after = await loadBoard(boardPath);
    const delivery = after.board.items[0]!.delivery!;
    expect(delivery.branch).toBe("feature");
    expect(delivery.base).toBe("main");
    expect(delivery.error).toBeNull();
    expect(delivery.attempted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(delivery.pr).toEqual(outcome.pr!);
    // The changes and the other card are untouched by the delivery.
    expect(findChange(after.board, "OV-500-C1")!.change).toEqual(MERGED_CHANGE);
    expect(after.board.items[1]!.delivery).toBeUndefined();
  }, 20_000);

  test("(a) the head defaults to the current branch of the main checkout", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root }),
    );

    expect(outcome.status).toBe("created");
    expect((await loadBoard(boardPath)).board.items[0]!.delivery!.branch).toBe(
      "feature",
    );
  }, 20_000);

  test("(b) an open pull request is edited, never created, and keeps its title", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [{ number: 99, url: "https://github.com/o/r/pull/99" }],
      "body-99.json": {
        body:
          "Renamed and rewritten by a person.\n\n" +
          "<!-- overlord:card OV-500 -->\nthe old section\n" +
          "<!-- /overlord:card OV-500 -->\n",
      },
      "pr-edit.txt": "https://github.com/o/r/pull/99\n",
      "view-99.json": DELIVERY_VIEW,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.warnings).toEqual([]);
    expect(outcome.status).toBe("updated");
    expect(outcome.pr!.number).toBe(99);

    const calls = await ghCalls(stub);
    expect(calls.some((call) => call[1] === "create")).toBe(false);
    const edited = calls.find((call) => call[1] === "edit")!;
    expect(edited.slice(0, 4)).toEqual(["pr", "edit", "99", "--body"]);
    // The title is deliberately absent: a person may have renamed the pull
    // request, and re-delivering must not undo that.
    expect(edited).not.toContain("--title");
    expect(edited.length).toBe(5);
    // The card's own section is replaced; the rest of the body survives.
    expect(edited[4]).toContain("Renamed and rewritten by a person.");
    expect(edited[4]).not.toContain("the old section");
    expect(edited[4]).toContain("- OV-500-C1  The merged change  (done)  #50");

    expect((await loadBoard(boardPath)).board.items[0]!.delivery!.pr!.number).toBe(
      99,
    );
  }, 20_000);

  test("(c) a card with an unmerged change is blocked, and nothing is created or written", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE, OPEN_CHANGE]);
    const before = await Bun.file(boardPath).text();
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "view-51.json": VIEW_51_OPEN,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.unmerged).toEqual(["OV-500-C2  The open change"]);
    expect(outcome.reason).toContain("1 of 2 changes of OV-500 are not merged");
    expect(outcome.pr).toBeUndefined();

    // Only the two synchronization reads: no pull request was created or
    // edited, so a half-finished card cannot reach the default branch.
    const calls = await ghCalls(stub);
    expect(calls.map((call) => call.slice(0, 3).join(" "))).toEqual([
      "pr view 50",
      "pr view 51",
    ]);
    expect(calls.some((call) => call[1] === "create" || call[1] === "edit")).toBe(
      false,
    );

    // The branch was not pushed either.
    expect(
      (await git(["rev-parse", "--verify", "--quiet", "origin/feature"], repo.root))
        .code,
    ).not.toBe(0);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("(d) a change the synchronization finds merged does not block the delivery", async () => {
    const repo = await deliveryRepo();
    // The board still says `reviewing`, which is what a change merged in the
    // GitHub web UI looks like until something reads the pull request.
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE, OPEN_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "view-51.json": { ...VIEW_51_OPEN, state: "MERGED" },
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.status).toBe("created");
    expect(outcome.unmerged).toBeUndefined();

    const after = await loadBoard(boardPath);
    // The synchronization wrote the merge it found, before the block decision.
    const change = findChange(after.board, "OV-500-C2")!.change;
    expect(change.state).toBe("done");
    expect(change.pr!.state).toBe("merged");
    expect(after.board.items[0]!.delivery!.pr!.number).toBe(99);
  }, 20_000);

  test("(e) a head with nothing to propose is skipped without calling gh", async () => {
    const repo = await deliveryRepo();
    // No change carries a pull request, so there is nothing to synchronize.
    const boardPath = await writeDeliveryBoard([
      { id: "OV-500-C1", title: "Merged by hand", state: "done", pr: null },
    ]);
    const before = await Bun.file(boardPath).text();
    const stub = await deliverGhStub({});

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "same" }),
    );

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("no-diff");
    expect(outcome.warnings).toEqual([]);
    expect(await ghCalls(stub)).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("(e) delivering the base branch into itself is skipped", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([
      { id: "OV-500-C1", title: "Merged by hand", state: "done", pr: null },
    ]);
    const stub = await deliverGhStub({});

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "main" }),
    );

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("same-branch");
    expect(await ghCalls(stub)).toEqual([]);
  }, 20_000);

  test("(f) a pull request on another head branch fails and the board is untouched", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const before = await Bun.file(boardPath).text();
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": { ...DELIVERY_VIEW, headRefName: "someone/else" },
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain('"someone/else" -> "main"');
    expect(outcome.reason).toContain('not "feature" -> "main"');
    expect(outcome.pr).toBeUndefined();
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("(f) a pull request against another base fails and the board is untouched", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const before = await Bun.file(boardPath).text();
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": { ...DELIVERY_VIEW, baseRefName: "some-release" },
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain('"feature" -> "some-release"');
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("(g) a base the head does not contain is warned about, and the delivery completes", async () => {
    const repo = await deliveryRepo();
    await advanceBase(repo.root, "release.txt", "shipped\n");
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    // The commit on main is named, and the merge is clean, so nothing is said
    // about a conflict.
    expect(outcome.warnings).toEqual([
      "origin/main has 1 commit not in feature; this delivery does not merge " +
        "origin/main into feature",
    ]);
    // The warning changes nothing: the pull request was created and recorded.
    expect(outcome.status).toBe("created");
    expect(outcome.pr!.number).toBe(99);
    expect((await loadBoard(boardPath)).board.items[0]!.delivery!.pr!.number).toBe(
      99,
    );
    // And the base was left where it was: nothing was merged into the head.
    expect(
      (await git(["merge-base", "--is-ancestor", "origin/main", "feature"], repo.root))
        .code,
    ).toBe(1);
  }, 20_000);

  test("(g) a base that conflicts with the head is reported as a conflict too", async () => {
    const repo = await deliveryRepo();
    await Bun.write(join(repo.root, "README.md"), "rewritten by the card\n");
    await gitIn(["add", "-A"], repo.root);
    await gitIn(["commit", "--quiet", "-m", "feature rewrites the readme"], repo.root);
    await advanceBase(repo.root, "README.md", "rewritten on main\n");
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    // Two separate facts, in two lines: the base moved on, and merging it
    // would conflict. A conflict does not block the delivery either.
    expect(outcome.warnings).toEqual([
      "origin/main has 1 commit not in feature; this delivery does not merge " +
        "origin/main into feature",
      "merging origin/main into feature conflicts in 1 file: README.md",
    ]);
    expect(outcome.status).toBe("created");
    expect((await loadBoard(boardPath)).board.items[0]!.delivery!.pr!.number).toBe(
      99,
    );
  }, 20_000);

  test("(g) a base the head already contains is not warned about", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    // `feature` was branched off `main` and `main` has not moved since, which
    // is the ordinary state of a branch about to be delivered.
    expect(
      (await git(["merge-base", "--is-ancestor", "origin/main", "feature"], repo.root))
        .code,
    ).toBe(0);

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.status).toBe("created");
    expect(outcome.warnings).toEqual([]);
  }, 20_000);

  test("(g) a base with a history of its own is reported as a merge that could not be attempted", async () => {
    const repo = await deliveryRepo();
    await unrelatedBase(repo.root, "unrelated");
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": { ...DELIVERY_VIEW, baseRefName: "unrelated" },
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({
        boardPath,
        cardId: "OV-500",
        cwd: repo.root,
        head: "feature",
        base: "unrelated",
      }),
    );

    // `git merge-tree` refuses two histories with no commit in common, so
    // whether they conflict was never decided and the warning says so instead
    // of claiming a clean merge.
    expect(outcome.warnings).toEqual([
      "origin/unrelated has 1 commit not in feature; this delivery does not " +
        "merge origin/unrelated into feature",
      "git merge-tree --write-tree origin/unrelated feature failed, so whether " +
        "those commits conflict is unknown: " +
        "fatal: refusing to merge unrelated histories",
    ]);
    // Not knowing does not stop the delivery either.
    expect(outcome.status).toBe("created");
    expect((await loadBoard(boardPath)).board.items[0]!.delivery!.pr!.number).toBe(
      99,
    );
  }, 20_000);

  test("(g) a merge-tree that exits like a conflict with nothing on stdout is still a failure", async () => {
    const repo = await deliveryRepo();
    await advanceBase(repo.root, "release.txt", "shipped\n");
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });
    // Exit 1 is what a conflict exits with too, so only the empty stdout
    // separates this from one.
    const failingMergeTree = await gitStub("merge-tree", {
      code: 1,
      stderr: "merge-tree: origin/main - not something we can merge\n",
    });

    const outcome = await withGitStub(failingMergeTree, () =>
      withGhStub(stub, () =>
        deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
      ),
    );

    // Read as the failure it is, and never as a conflict in no files.
    expect(outcome.warnings).toEqual([
      "origin/main has 1 commit not in feature; this delivery does not merge " +
        "origin/main into feature",
      "git merge-tree --write-tree origin/main feature failed, so whether " +
        "those commits conflict is unknown: " +
        "merge-tree: origin/main - not something we can merge",
    ]);
    expect(outcome.status).toBe("created");
  }, 20_000);

  test("(g) a conflict in more files than fit names the first few and counts the rest", async () => {
    const repo = await deliveryRepo();
    const paths = await conflictingFiles(repo.root, 7);
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    // The total is on the same line, so the list stops at five paths rather
    // than growing with the size of the conflict.
    expect(outcome.warnings[1]).toBe(
      `merging origin/main into feature conflicts in 7 files: ` +
        `${paths.slice(0, 5).join(", ")}, and 2 more`,
    );
    expect(outcome.status).toBe("created");
  }, 20_000);

  test("(g) a base ahead of a head it already holds every change of is skipped, and warned about not at all", async () => {
    const repo = await deliveryRepo();
    await mergeHeadIntoBase(repo.root);
    // No change carries a pull request, so nothing is synchronized and any
    // `gh` call would be this delivery's own.
    const boardPath = await writeDeliveryBoard([
      { id: "OV-500-C1", title: "Merged by hand", state: "done", pr: null },
    ]);
    const before = await Bun.file(boardPath).text();
    const stub = await deliverGhStub({});

    // `origin/main` really is ahead of `feature`, by the merge commit: asked
    // about, it would produce a warning.
    expect(
      (await git(["merge-base", "--is-ancestor", "origin/main", "feature"], repo.root))
        .code,
    ).toBe(1);

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    // There is nothing to propose, so the base is never asked about: a card
    // whose work already landed is reported as skipped and nothing else.
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("no-diff");
    expect(outcome.warnings).toEqual([]);
    expect(await ghCalls(stub)).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("writes nothing to stdout or stderr, on either the delivered or the blocked path", async () => {
    const repo = await deliveryRepo();
    const delivered = await writeDeliveryBoard([MERGED_CHANGE]);
    const blocked = await writeDeliveryBoard([MERGED_CHANGE, OPEN_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "view-51.json": VIEW_51_OPEN,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const statuses: string[] = [];
    const { stdout, stderr } = await withGhStub(stub, () =>
      capture(async () => {
        for (const boardPath of [delivered, blocked]) {
          const outcome = await deliverCard({
            boardPath,
            cardId: "OV-500",
            cwd: repo.root,
            head: "feature",
          });
          statuses.push(outcome.status);
        }
        return 0;
      }),
    );

    expect(statuses).toEqual(["created", "blocked"]);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  }, 20_000);

  test("a pull request that could not be read is a warning, and the card stays blocked", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE, OPEN_CHANGE]);
    const before = await Bun.file(boardPath).text();
    // No canned answer for 51, so its state cannot be confirmed.
    const stub = await deliverGhStub({ "view-50.json": VIEW_50_UNCHANGED });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.warnings.join("\n")).toContain(
      "OV-500-C2: gh pr view 51 failed",
    );
    expect(outcome.unmerged).toEqual(["OV-500-C2  The open change"]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("a detached HEAD fails before anything is pushed or written", async () => {
    const repo = await deliveryRepo();
    await shell(["git", "checkout", "--quiet", "--detach"], repo.root);
    const boardPath = await writeDeliveryBoard([
      { id: "OV-500-C1", title: "Merged by hand", state: "done", pr: null },
    ]);
    const before = await Bun.file(boardPath).text();
    const stub = await deliverGhStub({});

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("detached HEAD");
    expect(await ghCalls(stub)).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("an unknown card id fails without touching the repository", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const before = await Bun.file(boardPath).text();
    const stub = await deliverGhStub({});

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-999", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("unknown card id: OV-999");
    expect(await ghCalls(stub)).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("the base falls back to the GitHub default branch when origin/HEAD is unset", async () => {
    const repo = await deliveryRepo();
    await shell(
      ["git", "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
      repo.root,
    );
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "repo-view.json": { defaultBranchRef: { name: "main" } },
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const outcome = await withGhStub(stub, () =>
      deliverCard({ boardPath, cardId: "OV-500", cwd: repo.root, head: "feature" }),
    );

    expect(outcome.status).toBe("created");
    const calls = await ghCalls(stub);
    expect(calls[1]).toEqual(["repo", "view", "--json", "defaultBranchRef"]);
    expect((await loadBoard(boardPath)).board.items[0]!.delivery!.base).toBe("main");
  }, 20_000);
});

describe("deliver", () => {
  /** Run `deliver` from inside `cwd`, which is the directory it resolves. */
  async function runDeliver(
    argv: string[],
    cwd: string,
    stub: { dir: string; log: string },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      return await withGhStub(stub, () => capture(() => deliver(argv)));
    } finally {
      process.chdir(previous);
    }
  }

  test("without a card id it prints the usage and exits 2", async () => {
    const { code, stderr } = await captureStderr(() => deliver([]));
    expect(code).toBe(2);
    expect(stderr).toContain("usage: change deliver <card-id>");
  }, 20_000);

  test("a delivered card is reported and exits 0", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const { code, stdout, stderr } = await runDeliver(
      ["OV-500", "--board", boardPath, "--head", "feature"],
      repo.root,
      stub,
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("card:             OV-500");
    expect(stdout).toContain("delivery:         created");
    expect(stdout).toContain("pull request:     #99 (open)");
    expect(stdout).toContain(`board updated:    ${boardPath}`);
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "https://github.com/o/r/pull/99",
    );
  }, 20_000);

  test("a blocked card names the unmerged changes and exits 1", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE, OPEN_CHANGE]);
    const before = await Bun.file(boardPath).text();
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "view-51.json": VIEW_51_OPEN,
    });

    const { code, stdout, stderr } = await runDeliver(
      ["OV-500", "--board", boardPath, "--head", "feature"],
      repo.root,
      stub,
    );

    expect(code).toBe(1);
    expect(stdout).toContain("delivery:         blocked");
    expect(stdout).not.toContain("board updated");
    expect(stderr).toContain("not merged:       OV-500-C2  The open change");
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("a base the head does not contain is warned about on stderr and still exits 0", async () => {
    const repo = await deliveryRepo();
    await advanceBase(repo.root, "release.txt", "shipped\n");
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const stub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const { code, stdout, stderr } = await runDeliver(
      ["OV-500", "--board", boardPath, "--head", "feature"],
      repo.root,
      stub,
    );

    // The same exit code as a delivery with nothing to warn about.
    expect(code).toBe(0);
    expect(stderr.trimEnd()).toBe(
      "origin/main has 1 commit not in feature; this delivery does not merge " +
        "origin/main into feature",
    );
    expect(stdout).toContain("delivery:         created");
    expect(stdout).toContain("pull request:     #99 (open)");
  }, 20_000);

  test("a skipped run reports why and still exits 0", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([
      { id: "OV-500-C1", title: "Merged by hand", state: "done", pr: null },
    ]);
    const stub = await deliverGhStub({});

    const { code, stdout, stderr } = await runDeliver(
      ["OV-500", "--board", boardPath, "--head", "same"],
      repo.root,
      stub,
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("delivery:         skipped");
    expect(stdout).toContain("reason:           no-diff");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/** The commit both the pull request head and the review point at. */
const MERGE_SHA = "d".repeat(40);

/** One green GitHub Actions check, as `gh pr view` reports it. */
function checkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "CheckRun",
    name: "console",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    workflowName: "ci",
    ...overrides,
  };
}

/**
 * The `gh pr view` answer for the change pull request under test.
 *
 * Everything is set so that every gate passes; each test overrides the one
 * field its gate reads, so a refusal can only come from the gate it is about.
 */
function mergeView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 60,
    url: "https://github.com/o/r/pull/60",
    state: "OPEN",
    headRefOid: MERGE_SHA,
    headRefName: "overlord/OV-600-C1",
    baseRefName: "overlord-console",
    statusCheckRollup: [checkRun()],
    ...overrides,
  };
}

/** The same pull request after the merge, as the board read-back sees it. */
function mergedView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 60,
    url: "https://github.com/o/r/pull/60",
    state: "MERGED",
    headRefOid: MERGE_SHA,
    headRefName: "overlord/OV-600-C1",
    ...overrides,
  };
}

/** A board with one reviewed, still open change to merge. */
function mergeBoardWith(overrides: Partial<Change> = {}): Board {
  return {
    version: 1,
    updated_at: "2026-08-01T00:00:00Z",
    items: [
      {
        id: "OV-600",
        title: "A card being built",
        state: "implementing",
        next_action: "merge the reviewed change",
        changes: [
          {
            id: "OV-600-C1",
            title: "The reviewed change",
            state: "reviewing",
            branch: "overlord/OV-600-C1",
            pr: {
              number: 60,
              url: "https://github.com/o/r/pull/60",
              state: "open",
              head_sha: MERGE_SHA,
              reviewed_sha: MERGE_SHA,
            },
            ...overrides,
          },
        ],
      },
    ],
  };
}

async function writeMergeBoard(overrides: Partial<Change> = {}): Promise<string> {
  const boardPath = join(await scratch(), "board.yaml");
  await saveBoard(boardPath, mergeBoardWith(overrides));
  return boardPath;
}

/**
 * A `gh` on PATH for `change merge`.
 *
 * It answers the same way `deliverGhStub` does and records every argument
 * vector, so the tests can assert that a refused run never called
 * `gh pr merge` — which is the property every gate exists for. The two
 * `gh pr view` calls of one merge ask for different fields, and the canned
 * answers are keyed on that: the gate reads `statusCheckRollup`, the board
 * read-back after the merge does not.
 */
async function mergeGhStub(
  answers: Record<string, unknown>,
): Promise<{ dir: string; log: string }> {
  const dir = await scratch();
  const log = join(dir, "gh.log");
  const script = [
    "#!/bin/sh",
    `printf '%s\\037' "$@" | base64 | tr -d '\\n' >> "$GH_STUB_LOG"`,
    `printf '\\n' >> "$GH_STUB_LOG"`,
    'f=""',
    'case "$1 $2" in',
    '  "pr merge") f="merge-$3.txt" ;;',
    '  "repo view") f="repo-view.json" ;;',
    '  "pr view")',
    '    case "$*" in',
    '      *statusCheckRollup*) f="check-$3.json" ;;',
    '      *) f="view-$3.json" ;;',
    "    esac",
    "    ;;",
    "esac",
    'if [ -n "$f" ] && [ -f "$GH_STUB_DIR/$f" ]; then',
    '  cat "$GH_STUB_DIR/$f"',
    "  exit 0",
    "fi",
    'echo "stub gh: no canned answer for: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  const executable = join(dir, "gh");
  await Bun.write(executable, script);
  chmodSync(executable, 0o755);

  for (const [name, value] of Object.entries(answers)) {
    await Bun.write(
      join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  return { dir, log };
}

/** The canned answers of a merge that passes every gate. */
function mergeAnswers(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    "check-60.json": mergeView(),
    "merge-60.txt": "Merged pull request #60\n",
    "view-60.json": mergedView(),
    ...overrides,
  };
}

/** Whether the stub was asked to merge anything. */
async function mergedPullRequests(stub: { log: string }): Promise<string[][]> {
  return (await ghCalls(stub)).filter(
    (call) => call[0] === "pr" && call[1] === "merge",
  );
}

describe("checkRollup", () => {
  test("a pull request with no check at all is not verified", () => {
    for (const rollup of [[], null, undefined, "unreadable"]) {
      const state = checkRollup(rollup);
      expect(state.total).toBe(0);
      expect(state.passed).toBe(0);
      expect(state.reason).toContain("no check has run");
    }
  });

  test("reads the GraphQL connection shape as well as the flat array", () => {
    expect(checkRollup({ nodes: [checkRun()] }).reason).toBeNull();
    expect(checkRollup([checkRun()]).reason).toBeNull();
  });

  test("a green run passes and counts what passed", () => {
    const state = checkRollup([checkRun(), checkRun({ name: "frontend" })]);
    expect(state).toEqual({ total: 2, passed: 2, reason: null });
  });

  test("a failing check is named", () => {
    const state = checkRollup([
      checkRun(),
      checkRun({ name: "frontend", conclusion: "FAILURE" }),
    ]);
    expect(state.passed).toBe(1);
    expect(state.reason).toBe("1 of 2 checks did not pass: frontend");
  });

  test("every non-passing conclusion fails", () => {
    for (const conclusion of [
      "FAILURE",
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
      "STALE",
    ]) {
      expect(checkRollup([checkRun({ conclusion })]).reason).toContain(
        "did not pass",
      );
    }
  });

  test("an unfinished check is neither a pass nor a failure", () => {
    for (const status of ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING"]) {
      const state = checkRollup([checkRun({ status, conclusion: null })]);
      expect(state.passed).toBe(0);
      expect(state.reason).toContain("have not finished");
    }
  });

  test("a status context is read from its state", () => {
    const context = (state: string) => ({
      __typename: "StatusContext",
      context: "buildkite",
      state,
    });
    expect(checkRollup([context("SUCCESS")]).reason).toBeNull();
    expect(checkRollup([context("PENDING")]).reason).toContain(
      "have not finished",
    );
    expect(checkRollup([context("FAILURE")]).reason).toContain("did not pass");
    expect(checkRollup([context("ERROR")]).reason).toContain("did not pass");
  });

  test("a run where everything was skipped verified nothing", () => {
    const state = checkRollup([
      checkRun({ conclusion: "SKIPPED" }),
      checkRun({ name: "frontend", conclusion: "NEUTRAL" }),
    ]);
    expect(state.total).toBe(2);
    expect(state.passed).toBe(0);
    expect(state.reason).toContain("none of the 2 checks concluded successfully");
  });

  test("a skipped check next to a passing one does not block the merge", () => {
    const state = checkRollup([
      checkRun(),
      checkRun({ name: "frontend", conclusion: "SKIPPED" }),
    ]);
    expect(state).toEqual({ total: 2, passed: 1, reason: null });
  });

  test("a wide failure names five checks and counts the rest", () => {
    const failing = Array.from({ length: 8 }, (_, index) =>
      checkRun({ name: `job-${index + 1}`, conclusion: "FAILURE" }),
    );
    expect(checkRollup(failing).reason).toBe(
      "8 of 8 checks did not pass: job-1, job-2, job-3, job-4, job-5, and 3 more",
    );
  });

  test("checkOutcome reads an entry that is not an object as unfinished", () => {
    expect(checkOutcome(null)).toBe("pending");
    expect(checkOutcome("green")).toBe("pending");
    expect(checkOutcome({})).toBe("pending");
  });
});

describe("mergeRefusal", () => {
  function candidate(overrides: Record<string, unknown> = {}) {
    const view = { ...mergeView(), ...(overrides.view as object ?? {}) };
    return {
      changeId: "OV-600-C1",
      branch: "overlord/OV-600-C1",
      reviewedSha: MERGE_SHA,
      defaultBranch: "main",
      checks: checkRollup(view.statusCheckRollup),
      ...overrides,
      view: view as unknown as MergeView,
    };
  }

  test("a pull request that passes every gate is not refused", () => {
    expect(mergeRefusal(candidate())).toBeNull();
  });

  test("main and master are refused whatever the default branch is", () => {
    for (const base of ["main", "Main", "MAIN", "master"]) {
      const reason = mergeRefusal(
        candidate({ view: { baseRefName: base }, defaultBranch: "develop" }),
      );
      expect(reason).toContain(`merges into "${base}"`);
      expect(reason).toContain("user's to perform");
    }
  });

  test("the repository default branch is refused under any name", () => {
    const reason = mergeRefusal(
      candidate({ view: { baseRefName: "develop" }, defaultBranch: "develop" }),
    );
    expect(reason).toContain("the repository default branch");
  });

  test("a default branch that could not be named refuses rather than passes", () => {
    const reason = mergeRefusal(candidate({ defaultBranch: null }));
    expect(reason).toContain("default branch could not be determined");
  });

  test("a pull request without a base branch is refused", () => {
    expect(mergeRefusal(candidate({ view: { baseRefName: "" } }))).toContain(
      "does not name a base branch",
    );
  });

  test("the base is decided before anything else, so a delivery pull request cannot slip past another gate", () => {
    // Everything else is wrong as well; the base is still what is reported.
    const reason = mergeRefusal(
      candidate({
        view: {
          baseRefName: "main",
          headRefName: "feature",
          state: "CLOSED",
          statusCheckRollup: [],
        },
        reviewedSha: null,
      }),
    );
    expect(reason).toContain('merges into "main"');
  });

  test("a pull request on another branch is refused", () => {
    const reason = mergeRefusal(
      candidate({ view: { headRefName: "overlord/OV-600-C2" } }),
    );
    expect(reason).toContain('is on branch "overlord/OV-600-C2"');
  });

  test("a change with no branch on the board is refused", () => {
    expect(mergeRefusal(candidate({ branch: null }))).toContain(
      "has no branch on the board",
    );
  });

  test("a pull request that is not open has nothing to merge", () => {
    for (const state of ["MERGED", "CLOSED"]) {
      expect(mergeRefusal(candidate({ view: { state } }))).toContain(
        "not open",
      );
    }
  });

  test("a change with no reviewed_sha is refused", () => {
    for (const reviewedSha of [null, undefined, ""]) {
      expect(mergeRefusal(candidate({ reviewedSha }))).toContain(
        "no reviewed_sha on the board",
      );
    }
  });

  test("a head that is not the reviewed commit is refused", () => {
    expect(mergeRefusal(candidate({ reviewedSha: "e".repeat(40) }))).toContain(
      "commits were added after the review",
    );
  });

  test("an abbreviated reviewed_sha still names the head commit", () => {
    expect(mergeRefusal(candidate({ reviewedSha: MERGE_SHA.slice(0, 7) }))).toBeNull();
  });

  test("a CI that did not pass is refused", () => {
    const reason = mergeRefusal(
      candidate({ view: { statusCheckRollup: [checkRun({ conclusion: "FAILURE" })] } }),
    );
    expect(reason).toContain("did not pass");
  });

  test("a pull request with no check is refused", () => {
    const reason = mergeRefusal(candidate({ view: { statusCheckRollup: [] } }));
    expect(reason).toContain("no check has run");
  });
});

describe("mergeChange", () => {
  test("a reviewed, green change is merged with a merge commit and recorded", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(mergeAnswers());

    const saves = await countSaves(async () => {
      const outcome = await withGhStub(stub, () =>
        mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
      );
      expect(outcome.status).toBe("merged");
      expect(outcome.reason).toBeUndefined();
      expect(outcome.changeState).toBe("done");
      expect(outcome.pr).toEqual({
        number: 60,
        url: "https://github.com/o/r/pull/60",
        state: "merged",
        head_sha: MERGE_SHA,
        reviewed_sha: MERGE_SHA,
      });
      expect(outcome.checked).toEqual({
        number: 60,
        state: "open",
        head: "overlord/OV-600-C1",
        base: "overlord-console",
        reviewedSha: MERGE_SHA,
        checks: { total: 1, passed: 1, reason: null },
      });
    });

    // One board write, as every other change command performs.
    expect(saves).toBe(1);

    const { board } = await loadBoard(boardPath);
    const change = findChange(board, "OV-600-C1")!.change;
    expect(change.state).toBe("done");
    expect(change.pr!.state).toBe("merged");
    // Written by the sync path, so `reviewed_sha` is carried over untouched.
    expect(change.pr!.reviewed_sha).toBe(MERGE_SHA);
    // The card is the commander's to move; the merge does not move it.
    expect(board.items[0]!.state).toBe("implementing");

    // A merge commit, and nothing else: no --squash, --rebase, --admin or
    // --delete-branch was passed.
    expect(await mergedPullRequests(stub)).toEqual([
      ["pr", "merge", "60", "--merge"],
    ]);
  }, 20_000);

  test("a base of main is refused and nothing is merged or written", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const before = await Bun.file(boardPath).text();
    const stub = await mergeGhStub(
      mergeAnswers({ "check-60.json": mergeView({ baseRefName: "main" }) }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain('merges into "main"');
    expect(outcome.reason).toContain("Nothing was merged");
    expect(await mergedPullRequests(stub)).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("a base of master is refused", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({ "check-60.json": mergeView({ baseRefName: "master" }) }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain('merges into "master"');
    expect(await mergedPullRequests(stub)).toEqual([]);
  }, 20_000);

  test("a base that is the repository default branch is refused under its own name", async () => {
    const repo = await deliveryRepo();
    // No origin/HEAD, so the default branch is the one GitHub names.
    await gitIn(["symbolic-ref", "-d", "refs/remotes/origin/HEAD"], repo.root);
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({
        "check-60.json": mergeView({ baseRefName: "develop" }),
        "repo-view.json": { defaultBranchRef: { name: "develop" } },
      }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("the repository default branch");
    expect(await mergedPullRequests(stub)).toEqual([]);
  }, 20_000);

  test("a default branch that cannot be determined refuses rather than merges", async () => {
    const repo = await deliveryRepo();
    await gitIn(["symbolic-ref", "-d", "refs/remotes/origin/HEAD"], repo.root);
    const boardPath = await writeMergeBoard();
    // No repo-view.json: `gh repo view` fails, so nothing can name the branch.
    const stub = await mergeGhStub(mergeAnswers());

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("default branch could not be determined");
    expect(await mergedPullRequests(stub)).toEqual([]);
  }, 20_000);

  test("the delivery pull request deliverCard opens is refused", async () => {
    const repo = await deliveryRepo();
    const deliveryBoard = await writeDeliveryBoard([MERGED_CHANGE]);
    const deliverStub = await deliverGhStub({
      "view-50.json": VIEW_50_UNCHANGED,
      "pr-list.json": [],
      "pr-create.txt": "created\n",
      "view-feature.json": DELIVERY_VIEW,
    });

    const delivered = await withGhStub(deliverStub, () =>
      deliverCard({
        boardPath: deliveryBoard,
        cardId: "OV-500",
        cwd: repo.root,
        head: "feature",
      }),
    );
    expect(delivered.status).toBe("created");
    const deliveryNumber = delivered.pr!.number!;

    // The delivery pull request recorded on a change, which is what a mistyped
    // `pr --number` leaves behind. Its head branch is the one the board would
    // record for the change and its head commit is the reviewed one, so every
    // gate but the base passes and the base is the only thing that can refuse.
    const boardPath = join(await scratch(), "board.yaml");
    await saveBoard(
      boardPath,
      mergeBoardWith({
        branch: DELIVERY_VIEW.headRefName,
        pr: {
          number: deliveryNumber,
          url: DELIVERY_VIEW.url,
          state: "open",
          head_sha: DELIVERY_VIEW.headRefOid,
          reviewed_sha: DELIVERY_VIEW.headRefOid,
        },
      }),
    );
    const before = await Bun.file(boardPath).text();
    const stub = await mergeGhStub({
      [`check-${deliveryNumber}.json`]: {
        ...DELIVERY_VIEW,
        statusCheckRollup: [checkRun()],
      },
      [`merge-${deliveryNumber}.txt`]: "Merged\n",
      [`view-${deliveryNumber}.json`]: { ...DELIVERY_VIEW, state: "MERGED" },
    });

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain(`#${deliveryNumber} merges into "main"`);
    expect(await mergedPullRequests(stub)).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 30_000);

  test("a head that is not the reviewed commit is refused", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard({
      pr: {
        number: 60,
        url: "https://github.com/o/r/pull/60",
        state: "open",
        head_sha: MERGE_SHA,
        reviewed_sha: "e".repeat(40),
      },
    });
    const before = await Bun.file(boardPath).text();
    const stub = await mergeGhStub(mergeAnswers());

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("commits were added after the review");
    expect(await mergedPullRequests(stub)).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("a change that was never reviewed is refused", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard({
      pr: {
        number: 60,
        url: "https://github.com/o/r/pull/60",
        state: "open",
        head_sha: MERGE_SHA,
        reviewed_sha: null,
      },
    });
    const stub = await mergeGhStub(mergeAnswers());

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("no reviewed_sha on the board");
    expect(await mergedPullRequests(stub)).toEqual([]);
  }, 20_000);

  test("a failing CI is refused", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const before = await Bun.file(boardPath).text();
    const stub = await mergeGhStub(
      mergeAnswers({
        "check-60.json": mergeView({
          statusCheckRollup: [checkRun({ conclusion: "FAILURE" })],
        }),
      }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("did not pass");
    expect(await mergedPullRequests(stub)).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);

  test("a pull request with no check at all is refused", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({ "check-60.json": mergeView({ statusCheckRollup: [] }) }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("no check has run");
    expect(outcome.checked!.checks.total).toBe(0);
    expect(await mergedPullRequests(stub)).toEqual([]);
  }, 20_000);

  test("a pull request that is still running its checks is refused", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({
        "check-60.json": mergeView({
          statusCheckRollup: [
            checkRun(),
            checkRun({ name: "frontend", status: "IN_PROGRESS", conclusion: null }),
          ],
        }),
      }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("have not finished");
    expect(await mergedPullRequests(stub)).toEqual([]);
  }, 20_000);

  test("a pull request on another branch is refused", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({
        "check-60.json": mergeView({ headRefName: "overlord/OV-600-C2" }),
      }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain('is on branch "overlord/OV-600-C2"');
    expect(await mergedPullRequests(stub)).toEqual([]);
  }, 20_000);

  test("a pull request that is already merged is refused", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({ "check-60.json": mergeView({ state: "MERGED" }) }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("not open");
    expect(await mergedPullRequests(stub)).toEqual([]);
  }, 20_000);

  test("no environment variable turns a refusal into a merge", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({ "check-60.json": mergeView({ baseRefName: "main" }) }),
    );
    // Names a bypass would plausibly use. None of them exists, and this test
    // is what keeps it that way.
    const names = [
      "OVERLORD_FORCE",
      "OVERLORD_ALLOW_MAIN",
      "OVERLORD_MERGE_FORCE",
      "OVERLORD_SKIP_CI",
      "OVERLORD_SKIP_REVIEW",
      "OVERLORD_MERGE_BASE",
      "FORCE",
    ];
    for (const name of names) process.env[name] = "1";
    try {
      const outcome = await withGhStub(stub, () =>
        mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
      );
      expect(outcome.status).toBe("refused");
      expect(await mergedPullRequests(stub)).toEqual([]);
    } finally {
      for (const name of names) delete process.env[name];
    }
  }, 20_000);

  test("a change with no pull request on the board fails before any gh call", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard({ pr: null });
    const stub = await mergeGhStub(mergeAnswers());

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("has no pull request on the board");
    expect(await ghCalls(stub)).toEqual([]);
  }, 20_000);

  test("an unknown change id is reported and nothing is called", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(mergeAnswers());

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-999-C9", cwd: repo.root }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("unknown change id: OV-999-C9");
    expect(await ghCalls(stub)).toEqual([]);
  }, 20_000);

  test("a merge that GitHub does not report back is reported rather than assumed", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({ "view-60.json": mergedView({ state: "OPEN" }) }),
    );

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("was merged, but GitHub still reports");
    expect(outcome.reason).toContain("change sync OV-600");
    expect(await mergedPullRequests(stub)).toEqual([
      ["pr", "merge", "60", "--merge"],
    ]);
  }, 20_000);

  test("a merge that gh refuses leaves the board untouched", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const before = await Bun.file(boardPath).text();
    // No merge-60.txt, so the stub fails the merge the way a conflicting or a
    // protected pull request makes `gh pr merge` fail.
    const stub = await mergeGhStub({
      "check-60.json": mergeView(),
      "view-60.json": mergedView(),
    });

    const outcome = await withGhStub(stub, () =>
      mergeChange({ boardPath, changeId: "OV-600-C1", cwd: repo.root }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("gh pr merge 60 --merge failed");
    expect(await Bun.file(boardPath).text()).toBe(before);
  }, 20_000);
});

describe("merge CLI", () => {
  async function runMerge(
    argv: string[],
    cwd: string,
    stub: { dir: string; log: string },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      return await withGhStub(stub, () => capture(() => merge(argv)));
    } finally {
      process.chdir(previous);
    }
  }

  test("without a change id it prints the usage and exits 2", async () => {
    const { code, stderr } = await captureStderr(() => merge([]));
    expect(code).toBe(2);
    expect(stderr).toContain("usage: change merge <change-id>");
  });

  test("every option but --board is a usage error", async () => {
    const boardPath = await writeMergeBoard();
    const before = await Bun.file(boardPath).text();

    for (const option of [
      ["--base", "main"],
      ["--force"],
      ["--admin"],
      ["--squash"],
      ["--no-ci"],
    ]) {
      const { code, stderr } = await captureStderr(() =>
        merge(["OV-600-C1", "--board", boardPath, ...option, "x"]),
      );
      expect(code).toBe(2);
      expect(stderr).toContain("takes no option other than --board");
      expect(stderr).toContain("cannot be turned off");
    }
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("the usage text names no way to skip a check", async () => {
    const { code, stdout } = await capture(() => main(["--help"]));
    expect(code).toBe(0);
    expect(stdout).toContain("merge <change-id>");
    expect(stdout).toContain(
      "There is no option and no\n                      environment variable that skips any of those checks",
    );
    expect(stdout).toContain(
      "merge takes only <change-id> and --board; any other option is a usage error.",
    );
    // Nothing in the usage offers a way around the gates.
    expect(stdout).not.toContain("--force");
    expect(stdout).not.toContain("--admin");
  });

  test("a merged change is reported line by line and exits 0", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(mergeAnswers());

    const { code, stdout, stderr } = await runMerge(
      ["OV-600-C1", "--board", boardPath],
      repo.root,
      stub,
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe(
      [
        "change:           OV-600-C1",
        "pull request:     #60 (open)",
        "head branch:      overlord/OV-600-C1",
        "base branch:      overlord-console",
        `reviewed commit:  ${MERGE_SHA}`,
        "checks:           1 of 1 passed",
        "merged:           #60 with a merge commit",
        "change state:     done",
        `board updated:    ${boardPath}`,
        "https://github.com/o/r/pull/60",
        "",
      ].join("\n"),
    );
  }, 20_000);

  test("a refused merge reports what it checked on stdout and why on stderr, and exits 1", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeMergeBoard();
    const stub = await mergeGhStub(
      mergeAnswers({ "check-60.json": mergeView({ baseRefName: "main" }) }),
    );

    const { code, stdout, stderr } = await runMerge(
      ["OV-600-C1", "--board", boardPath],
      repo.root,
      stub,
    );

    expect(code).toBe(1);
    expect(stdout).toContain("base branch:      main");
    expect(stdout).not.toContain("merged:");
    expect(stdout).not.toContain("board updated:");
    expect(stderr).toContain('merges into "main"');
    expect(stderr).toContain(`Nothing was merged and nothing was written to ${boardPath}`);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// the agent account
// ---------------------------------------------------------------------------

/** The environment variables the cases below set and put back. */
const ACCOUNT_ENV = [
  "OVERLORD_GH_ACCOUNT",
  "OVERLORD_GH_TOKEN",
  "PATH",
  "GH_ACCOUNT_STUB_DIR",
  "GH_ACCOUNT_STUB_LOG",
  "GIT_PUSH_STUB_LOG",
];

/**
 * Run `body` with `overrides` applied to the environment, then put it back and
 * forget the resolved token.
 *
 * The token is cached for the life of the process, so a case that changed the
 * configuration would otherwise decide what the next one resolves.
 */
async function withAccount<T>(
  overrides: Record<string, string | undefined>,
  body: () => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const name of ACCOUNT_ENV) previous[name] = process.env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetAgentIdentityCache();
  try {
    return await body();
  } finally {
    for (const name of ACCOUNT_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    resetAgentIdentityCache();
  }
}

/**
 * A `gh` that records its argument vector and the tokens in its environment.
 *
 * `gh auth token --user <account>` answers with `<account>-token`, so what the
 * agent account resolved to and what reached the next `gh` call can be
 * compared. Every other subcommand prints an empty JSON document, which is
 * enough for the cases here: they assert on how `gh` was called, not on what
 * it answered.
 */
async function ghAccountStub(
  known: string[],
  answers: Record<string, string> = {},
): Promise<{
  dir: string;
  log: string;
  calls: () => Promise<{ argv: string; ghToken: string; githubToken: string }[]>;
}> {
  const dir = await scratch();
  const log = join(dir, "gh.log");
  const script = [
    "#!/bin/sh",
    `printf 'argv=%s\\tGH_TOKEN=%s\\tGITHUB_TOKEN=%s\\n' "$*" "$GH_TOKEN" "$GITHUB_TOKEN" >> "$GH_ACCOUNT_STUB_LOG"`,
    'if [ "$1 $2" = "auth token" ]; then',
    `  for account in ${known.map((a) => JSON.stringify(a)).join(" ")}; do`,
    '    if [ "$4" = "$account" ]; then echo "$account-token"; exit 0; fi',
    "  done",
    '  echo "no oauth token found for github.com account $4" >&2',
    "  exit 1",
    "fi",
    // `identity` asks who the token is and what it may do here; a case that
    // canned no answer for either gets a failing `gh`, not a silent success.
    'if [ -f "$GH_ACCOUNT_STUB_DIR/$1-$2.txt" ]; then',
    '  cat "$GH_ACCOUNT_STUB_DIR/$1-$2.txt"',
    "  exit 0",
    "fi",
    'if [ "$1" = pr ]; then echo \'{}\'; exit 0; fi',
    'echo "stub gh: no canned answer for: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  const executable = join(dir, "gh");
  await Bun.write(executable, script);
  chmodSync(executable, 0o755);
  for (const [name, value] of Object.entries(answers)) {
    await Bun.write(join(dir, `${name}.txt`), value);
  }
  return {
    dir,
    log,
    calls: async () => {
      if (!(await Bun.file(log).exists())) return [];
      return (await Bun.file(log).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [argv, ghToken, githubToken] = line.split("\t");
          return {
            argv: argv!.slice("argv=".length),
            ghToken: ghToken!.slice("GH_TOKEN=".length),
            githubToken: githubToken!.slice("GITHUB_TOKEN=".length),
          };
        });
    },
  };
}

/**
 * A `git` that records every `push` with the credential in its environment and
 * refuses it, and hands everything else to the real `git`.
 *
 * Refusing is what makes the cases safe: a test that reached a real `git push`
 * would write to a remote.
 */
async function gitPushStub(): Promise<{
  dir: string;
  log: string;
  pushes: () => Promise<{ argv: string[]; username: string; token: string }[]>;
}> {
  const dir = await scratch();
  const log = join(dir, "push.log");
  const real = await shell(["/bin/sh", "-c", "command -v git"], dir);
  const script = [
    "#!/bin/sh",
    'for argument in "$@"; do',
    '  if [ "$argument" = push ]; then',
    `    printf '%s\\037' "$@" | base64 | tr -d '\\n' >> "$GIT_PUSH_STUB_LOG"`,
    `    printf '\\t%s\\t%s\\n' "$OVERLORD_GIT_CREDENTIAL_USERNAME" "$OVERLORD_GIT_CREDENTIAL_TOKEN" >> "$GIT_PUSH_STUB_LOG"`,
    '    echo "stub git: refusing to push" >&2',
    "    exit 1",
    "  fi",
    "done",
    `exec ${JSON.stringify(real)} "$@"`,
    "",
  ].join("\n");
  const executable = join(dir, "git");
  await Bun.write(executable, script);
  chmodSync(executable, 0o755);
  return {
    dir,
    log,
    pushes: async () => {
      if (!(await Bun.file(log).exists())) return [];
      return (await Bun.file(log).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [encoded, username, token] = line.split("\t");
          return {
            argv: Buffer.from(encoded!, "base64")
              .toString("utf8")
              .split(ARG_SEPARATOR)
              .slice(0, -1),
            username: username ?? "",
            token: token ?? "",
          };
        });
    },
  };
}

describe("gh under the agent account", () => {
  test("no account configured leaves gh exactly as it was", async () => {
    const stub = await ghAccountStub([]);
    const result = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: undefined,
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_LOG: stub.log,
      },
      () => gh(["pr", "view", "7"]),
    );

    expect(result.code).toBe(0);
    const calls = await stub.calls();
    expect(calls.map((call) => call.argv)).toEqual(["pr view 7"]);
    // Nothing was resolved, so nothing was added to the environment either.
    expect(calls[0]!.ghToken).toBe("");
  });

  test("a configured account reaches gh as GH_TOKEN and not as an argument", async () => {
    const stub = await ghAccountStub(["ISSEI-BOT"]);
    const result = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: "ISSEI-BOT",
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_LOG: stub.log,
      },
      () => gh(["pr", "create", "--title", "t"]),
    );

    const calls = await stub.calls();
    expect(calls.map((call) => call.argv)).toEqual([
      "auth token --user ISSEI-BOT",
      "pr create --title t",
    ]);
    expect(calls[1]!.ghToken).toBe("ISSEI-BOT-token");
    // GITHUB_TOKEN is emptied, so an inherited one cannot decide the account.
    expect(calls[1]!.githubToken).toBe("");
    // The token is in the environment and nowhere else.
    expect(calls[1]!.argv).not.toContain("ISSEI-BOT-token");
    expect(result.stdout).not.toContain("ISSEI-BOT-token");
    expect(result.stderr).not.toContain("ISSEI-BOT-token");
  });

  test("an account gh does not know fails the call instead of using the active one", async () => {
    const stub = await ghAccountStub(["ISSEI-BOT"]);
    const result = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: "gone",
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_LOG: stub.log,
      },
      () => gh(["pr", "create", "--title", "t"]),
    );

    expect(result.code).toBe(RUN_FAILED);
    expect(result.stderr).toContain("OVERLORD_GH_ACCOUNT=gone");
    expect(result.stderr).toContain("no oauth token found");
    // `pr create` was never run: a pull request under the user's name is the
    // one outcome this must not produce.
    expect((await stub.calls()).map((call) => call.argv)).toEqual([
      "auth token --user gone",
    ]);
  });
});

describe("git push under the agent account", () => {
  test("an https github remote is pushed with the agent account's credential", async () => {
    const repo = await deliveryRepo();
    // Fetch keeps using the local bare origin, so only the push is redirected.
    await gitIn(
      ["remote", "set-url", "--push", "origin", "https://github.com/o/r.git"],
      repo.root,
    );
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const ghStub = await deliverGhStub({ "view-50.json": VIEW_50_UNCHANGED });
    const push = await gitPushStub();

    const outcome = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: undefined,
        OVERLORD_GH_TOKEN: "ghp_agent",
        PATH: `${push.dir}:${ghStub.dir}:${process.env.PATH ?? ""}`,
        GIT_PUSH_STUB_LOG: push.log,
      },
      () =>
        withGhStub(ghStub, () =>
          deliverCard({
            boardPath,
            cardId: "OV-500",
            cwd: repo.root,
            head: "feature",
          }),
        ),
    );

    expect(outcome.status).toBe("failed");
    const pushes = await push.pushes();
    expect(pushes).toHaveLength(1);
    const argv = pushes[0]!.argv;
    // The helper list is emptied first, or the macOS keychain and the helper
    // `gh auth setup-git` installs would answer with the user's account.
    expect(argv.slice(0, 5)).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      expect.stringContaining("credential.helper=!f()"),
      "push",
    ]);
    expect(argv.join(" ")).not.toContain("ghp_agent");
    expect(pushes[0]!.username).toBe("x-access-token");
    expect(pushes[0]!.token).toBe("ghp_agent");
  }, 20_000);

  test("a remote the token does not belong to is warned about, not sent the token", async () => {
    // `deliveryRepo` puts origin on a local path, which is every remote that
    // is not an https GitHub URL: an ssh remote behaves the same way.
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const ghStub = await deliverGhStub({ "view-50.json": VIEW_50_UNCHANGED });
    const push = await gitPushStub();

    const outcome = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: undefined,
        OVERLORD_GH_TOKEN: "ghp_agent",
        PATH: `${push.dir}:${ghStub.dir}:${process.env.PATH ?? ""}`,
        GIT_PUSH_STUB_LOG: push.log,
      },
      () =>
        withGhStub(ghStub, () =>
          deliverCard({
            boardPath,
            cardId: "OV-500",
            cwd: repo.root,
            head: "feature",
          }),
        ),
    );

    expect(outcome.warnings.join("\n")).toContain("not an HTTPS URL");
    const pushes = await push.pushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.argv[0]).toBe("push");
    expect(pushes[0]!.token).toBe("");
  }, 20_000);

  test("with no account configured the push is unchanged", async () => {
    const repo = await deliveryRepo();
    const boardPath = await writeDeliveryBoard([MERGED_CHANGE]);
    const ghStub = await deliverGhStub({ "view-50.json": VIEW_50_UNCHANGED });
    const push = await gitPushStub();

    const outcome = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: undefined,
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${push.dir}:${ghStub.dir}:${process.env.PATH ?? ""}`,
        GIT_PUSH_STUB_LOG: push.log,
      },
      () =>
        withGhStub(ghStub, () =>
          deliverCard({
            boardPath,
            cardId: "OV-500",
            cwd: repo.root,
            head: "feature",
          }),
        ),
    );

    expect(outcome.warnings).toEqual([]);
    const pushes = await push.pushes();
    expect(pushes[0]!.argv[0]).toBe("push");
  }, 20_000);
});

describe("pr names the account it acts as", () => {
  test("the account is on stdout and an unresolvable one stops the push", async () => {
    const boardPath = await writeStartedBoard();
    const before = await Bun.file(boardPath).text();
    const stub = await ghAccountStub(["ISSEI-BOT"]);
    const push = await gitPushStub();

    const { code, stdout, stderr } = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: "gone",
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${push.dir}:${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_LOG: stub.log,
        GIT_PUSH_STUB_LOG: push.log,
      },
      () => capture(() => pr(["OV-103-C1", "--board", boardPath])),
    );

    expect(code).toBe(1);
    expect(stdout).toContain("agent account:    (could not be resolved)");
    expect(stderr).toContain("OVERLORD_GH_ACCOUNT=gone");
    // Nothing was pushed and nothing was recorded: an account that cannot be
    // resolved must not fall back to whoever git would have used.
    expect(await push.pushes()).toEqual([]);
    expect(await Bun.file(boardPath).text()).toBe(before);
  });

  test("a resolvable account is named by its account name", async () => {
    const boardPath = await writeStartedBoard();
    const stub = await ghAccountStub(["ISSEI-BOT"]);
    const push = await gitPushStub();

    const { stdout } = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: "ISSEI-BOT",
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${push.dir}:${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_LOG: stub.log,
        GIT_PUSH_STUB_LOG: push.log,
      },
      () => capture(() => pr(["OV-103-C1", "--board", boardPath])),
    );

    expect(stdout).toContain("agent account:    ISSEI-BOT");
    expect(stdout).not.toContain("ISSEI-BOT-token");
  });

  test("no account configured says so instead of naming one", async () => {
    const boardPath = await writeStartedBoard();
    const push = await gitPushStub();

    const { stdout } = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: undefined,
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${push.dir}:${process.env.PATH ?? ""}`,
        GIT_PUSH_STUB_LOG: push.log,
      },
      () => capture(() => pr(["OV-103-C1", "--board", boardPath])),
    );

    expect(stdout).toContain(
      "agent account:    (none configured, using the active gh account)",
    );
  });
});

describe("change identity", () => {
  /** `identity` runs in the checkout it is called from, which is this one. */
  const HERE = { PATH: process.env.PATH ?? "" };

  test("no account configured reports it and exits 1", async () => {
    const { code, stdout, stderr } = await withAccount(
      { OVERLORD_GH_ACCOUNT: undefined, OVERLORD_GH_TOKEN: undefined, ...HERE },
      () => capture(() => identity([])),
    );

    expect(code).toBe(1);
    expect(stdout).toContain("agent account:    (none configured)");
    expect(stderr).toContain("OVERLORD_GH_ACCOUNT");
  });

  test("an account gh does not know exits 1 and checks nothing else", async () => {
    const stub = await ghAccountStub(["ISSEI-BOT"]);
    const { code, stderr } = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: "gone",
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_DIR: stub.dir,
        GH_ACCOUNT_STUB_LOG: stub.log,
      },
      () => capture(() => identity([])),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("OVERLORD_GH_ACCOUNT=gone");
    expect((await stub.calls()).map((call) => call.argv)).toEqual([
      "auth token --user gone",
    ]);
  });

  test("a token that authenticates as somebody else exits 1", async () => {
    const stub = await ghAccountStub(["ISSEI-BOT"], {
      "api-user": "ISSEI51\n",
    });
    const { code, stderr } = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: "ISSEI-BOT",
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_DIR: stub.dir,
        GH_ACCOUNT_STUB_LOG: stub.log,
      },
      () => capture(() => identity([])),
    );

    expect(code).toBe(1);
    expect(stderr).toContain('authenticates as "ISSEI51"');
  });

  test("an account without write access exits 1 and says what to grant", async () => {
    const stub = await ghAccountStub(["ISSEI-BOT"], {
      "api-user": "ISSEI-BOT\n",
      "repo-view": JSON.stringify({
        nameWithOwner: "ISSEI51/overlord-skill",
        viewerPermission: "READ",
      }),
    });
    const { code, stdout, stderr } = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: "ISSEI-BOT",
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_DIR: stub.dir,
        GH_ACCOUNT_STUB_LOG: stub.log,
      },
      () => capture(() => identity([])),
    );

    expect(code).toBe(1);
    expect(stdout).toContain("permission:       READ");
    expect(stderr).toContain("collaborator with write access");
  });

  test("a write collaborator on an https remote reports the whole chain", async () => {
    const stub = await ghAccountStub(["ISSEI-BOT"], {
      "api-user": "ISSEI-BOT\n",
      "repo-view": JSON.stringify({
        nameWithOwner: "ISSEI51/overlord-skill",
        viewerPermission: "WRITE",
      }),
    });
    const { code, stdout } = await withAccount(
      {
        OVERLORD_GH_ACCOUNT: "ISSEI-BOT",
        OVERLORD_GH_TOKEN: undefined,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`,
        GH_ACCOUNT_STUB_DIR: stub.dir,
        GH_ACCOUNT_STUB_LOG: stub.log,
      },
      () => capture(() => identity([])),
    );

    expect(code).toBe(0);
    expect(stdout).toContain("agent account:    ISSEI-BOT");
    expect(stdout).toContain("token source:     gh auth token --user ISSEI-BOT");
    expect(stdout).toContain("github login:     ISSEI-BOT");
    expect(stdout).toContain("permission:       WRITE");
    expect(stdout).toContain("push identity:    ISSEI-BOT");
    // The report is the whole point of the command; it must not leak the token.
    expect(stdout).not.toContain("ISSEI-BOT-token");
  });

  test("it takes no argument", async () => {
    for (const argv of [["OV-103"], ["--board", "/tmp/board.yaml"]]) {
      const { code, stderr } = await capture(() => identity(argv));
      expect(code).toBe(2);
      expect(stderr).toContain("change identity takes no argument");
    }
  });
});
