import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadBoard, saveBoard, type Board } from "./board.ts";
import {
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
  updateChange,
  worktreePathFor,
} from "./change.ts";

/** Run something with stderr captured, so a failing command stays quiet. */
async function captureStderr(
  body: () => Promise<number>,
): Promise<{ code: number; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await body(), stderr };
  } finally {
    process.stderr.write = original;
  }
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
