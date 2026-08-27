/**
 * The `change` CLI.
 *
 * One change is one worktree, one branch, one pull request and one agent
 * execution unit. This command owns the git side of that contract and records
 * the result on `board.yaml`, so an agent never has to hand-edit the board.
 *
 * Board writes go through the same helpers the console server uses
 * (`loadBoard` / `saveBoard` / `canonicalItem`), which keeps the YAML key
 * order, the block style and the atomic rename identical to a console write.
 *
 * Implemented subcommands:
 *   change start <change-id> [--board <path>] [--base <branch>]
 *   change pr    <change-id> [--board <path>] [--base <branch>] [--number <n>]
 */

import { dirname, resolve } from "node:path";

import {
  boardPathFor,
  canonicalItem,
  loadBoard,
  revisionOf,
  saveBoard,
  type Board,
  type Change,
  type Item,
  type State,
} from "./board.ts";

// ---------------------------------------------------------------------------
// board helpers
// ---------------------------------------------------------------------------

/** A change resolved back to the card that owns it. */
export type FoundChange = {
  item: Item;
  change: Change;
  /** Position of the change inside `item.changes`. */
  index: number;
};

/** Resolve a change id to its card. Exact match on `changes[].id`. */
export function findChange(
  board: Board,
  changeId: string,
): FoundChange | null {
  for (const item of board.items) {
    const changes = item.changes;
    if (!Array.isArray(changes)) continue;
    const index = changes.findIndex((change) => change?.id === changeId);
    if (index >= 0) return { item, change: changes[index]!, index };
  }
  return null;
}

export class ChangeNotFoundError extends Error {
  constructor(readonly changeId: string) {
    super(`unknown change id: ${changeId}`);
    this.name = "ChangeNotFoundError";
  }
}

/**
 * Read the board, mutate one change, write the board back.
 *
 * This bypasses the console server, so it cannot use the server's `rev`
 * optimistic lock. Instead the revision is re-read immediately before saving:
 * if the file changed since it was loaded, the board is re-read once and the
 * mutation is re-applied to the target change only, so a concurrent console
 * edit to a different card is preserved instead of being overwritten.
 *
 * Nothing outside the target change is rewritten; `board.updated_at` is
 * stamped by `saveBoard` as it is for every other writer.
 */
export async function updateChange(
  boardPath: string,
  changeId: string,
  mutate: (change: Change) => void,
): Promise<Change> {
  const loaded = await loadBoard(boardPath);
  let board = loaded.board;
  let found = findChange(board, changeId);
  if (!found) throw new ChangeNotFoundError(changeId);
  mutate(found.change);

  const current = await revisionOf(boardPath);
  if (current !== loaded.rev) {
    const reloaded = await loadBoard(boardPath);
    board = reloaded.board;
    found = findChange(board, changeId);
    if (!found) throw new ChangeNotFoundError(changeId);
    mutate(found.change);
  }

  const itemIndex = board.items.indexOf(found.item);
  if (itemIndex >= 0) board.items[itemIndex] = canonicalItem(found.item);
  await saveBoard(boardPath, board);
  return found.change;
}

/**
 * Board file to operate on: `--board <path>`, else `$OVERLORD_BOARD`, else the
 * current directory. Directory targets get the standard board suffix appended
 * by `boardPathFor`.
 */
export function resolveBoardPath(explicit?: string | null): string {
  const target = explicit ?? process.env.OVERLORD_BOARD ?? process.cwd();
  return boardPathFor(target);
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

export type RunResult = { code: number; stdout: string; stderr: string };

export class CommandError extends Error {
  constructor(
    readonly command: string[],
    readonly result: RunResult,
  ) {
    super(
      `${command.join(" ")} exited with ${result.code}: ` +
        (result.stderr.trim() || result.stdout.trim()),
    );
    this.name = "CommandError";
  }
}

async function run(command: string[], cwd?: string): Promise<RunResult> {
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
  return { code, stdout, stderr };
}

export async function runOrThrow(
  command: string[],
  cwd?: string,
): Promise<RunResult> {
  const result = await run(command, cwd);
  if (result.code !== 0) throw new CommandError(command, result);
  return result;
}

export function git(args: string[], cwd?: string): Promise<RunResult> {
  return run(["git", ...args], cwd);
}

export function gitOrThrow(args: string[], cwd?: string): Promise<RunResult> {
  return runOrThrow(["git", ...args], cwd);
}

export function gh(args: string[], cwd?: string): Promise<RunResult> {
  return run(["gh", ...args], cwd);
}

export function ghOrThrow(args: string[], cwd?: string): Promise<RunResult> {
  return runOrThrow(["gh", ...args], cwd);
}

/** Repository root containing `cwd`. */
export async function repoRoot(cwd?: string): Promise<string> {
  const result = await gitOrThrow(["rev-parse", "--show-toplevel"], cwd);
  return resolve(result.stdout.trim());
}

/**
 * Root of the main checkout, even when called from inside a linked worktree.
 *
 * A change worktree has its own `--show-toplevel`, but branches, remotes and
 * `gh` all belong to the one repository, so every git and `gh` call in `pr`
 * runs here.
 */
export async function mainRepoRoot(cwd?: string): Promise<string> {
  const result = await gitOrThrow(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  return dirname(resolve(result.stdout.trim()));
}

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

/** Branch that carries one change. */
export function branchNameFor(changeId: string): string {
  return `overlord/${changeId}`;
}

/** Worktree directory for one change, inside the repository root. */
export function worktreePathFor(root: string, changeId: string): string {
  return resolve(root, ".overlord/worktrees", changeId);
}

/** Absolute worktree paths listed by `git worktree list --porcelain`. */
export function parseWorktreePaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(resolve(line.slice("worktree ".length).trim()));
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export type ParsedArgs = {
  positional: string[];
  options: Record<string, string>;
};

/** Split `--key value` options out of an argument list. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0) {
      options[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option ${arg} needs a value`);
    }
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { positional, options };
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  const result = await git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    root,
  );
  return result.code === 0;
}

/**
 * Create (or reuse) the worktree and branch for a change and record them.
 *
 * Idempotent: an existing worktree is reused, an existing branch is checked
 * out instead of recreated, and the board ends up with the same values either
 * way. An unknown change id fails before anything is created or written.
 */
export async function start(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const changeId = positional[0];
  if (!changeId) {
    process.stderr.write("usage: change start <change-id>\n");
    return 2;
  }

  const boardPath = resolveBoardPath(options.board);
  const { board, exists } = await loadBoard(boardPath);
  if (!exists) {
    process.stderr.write(`board not found: ${boardPath}\n`);
    return 1;
  }
  if (!findChange(board, changeId)) {
    process.stderr.write(
      `unknown change id: ${changeId} (board: ${boardPath})\n`,
    );
    return 1;
  }

  const root = await repoRoot();
  const branch = branchNameFor(changeId);
  const worktree = worktreePathFor(root, changeId);
  const base =
    options.base ??
    (await gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();

  process.stdout.write(`base branch:      ${base}\n`);
  process.stdout.write(`change branch:    ${branch}\n`);
  process.stdout.write(`worktree path:    ${worktree}\n`);

  const existing = parseWorktreePaths(
    (await gitOrThrow(["worktree", "list", "--porcelain"], root)).stdout,
  );
  if (existing.includes(worktree)) {
    process.stdout.write("worktree already exists, reusing it\n");
  } else if (await branchExists(root, branch)) {
    process.stdout.write("branch already exists, checking it out\n");
    await gitOrThrow(["worktree", "add", worktree, branch], root);
  } else {
    await gitOrThrow(["worktree", "add", worktree, "-b", branch, base], root);
  }

  await updateChange(boardPath, changeId, (change) => {
    change.branch = branch;
    change.state = "implementing";
  });
  process.stdout.write(`board updated:    ${boardPath}\n`);

  process.stdout.write(`${worktree}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// pull request
// ---------------------------------------------------------------------------

/**
 * GitHub reports the pull request state in upper case (`OPEN`, `MERGED`,
 * `CLOSED`); the board stores it in lower case.
 *
 * Kept as a pure function so every command that reads a pull request maps the
 * state the same way. An unknown value is lower-cased and passed through
 * instead of being dropped, so a state GitHub adds later still reaches the
 * board; a missing or empty value becomes null.
 */
export function normalizePrState(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

/** Pull request title: the change title with the change id appended. */
export function prTitleFor(change: Change): string {
  return `${change.title} (${change.id})`;
}

/** Pull request body: enough context to find the card and the change again. */
export function prBodyFor(item: Item, change: Change): string {
  return [
    item.title,
    "",
    change.title,
    "",
    `Card: ${item.id}`,
    `Change: ${change.id}`,
    "",
  ].join("\n");
}

/**
 * The `gh pr view` fields the board needs.
 *
 * `headRefName` is not written to the board: it is read so the pull request
 * can be checked against the branch recorded for the change before anything
 * is written.
 */
export type PullRequestView = {
  number: number;
  url: string;
  state: string;
  headRefOid: string;
  headRefName: string;
};

const PR_VIEW_FIELDS = "number,url,state,headRefOid,headRefName";

/**
 * Parse a `--number <n>` value.
 *
 * `Number.parseInt` stops at the first character it cannot read, so it turns
 * `1abc` into 1, `3.9` into 3 and `1e3` into 1. Recording the wrong pull
 * request on a change is silent and destructive — it overwrites the correct
 * `pr` record — so the value has to be all digits before it is parsed.
 *
 * Returns null for anything that is not a positive decimal pull request
 * number.
 */
export function parsePrNumber(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/**
 * The change state that goes with a recorded pull request.
 *
 * Recording a pull request normally means the change is waiting for review.
 * A pull request that is already merged says the change is delivered, so it
 * lands on `done` instead of being sent back to `reviewing`; a closed pull
 * request says nothing about where the change stands, so whatever state the
 * board already holds is kept.
 */
export function changeStateForPr(
  prState: string | null,
  current: State,
): State {
  if (prState === "merged") return "done";
  if (prState === "closed") return current;
  return "reviewing";
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Show a failed command's own diagnostics instead of paraphrasing them. */
function reportFailure(result: RunResult): void {
  const message = result.stderr.trim() || result.stdout.trim();
  if (message) process.stderr.write(`${message}\n`);
}

/**
 * Make sure `origin/<branch>` exists and carries the local commits.
 *
 * This runs in the main repository rather than in the change worktree, so it
 * works whichever checkout the command was started from. The branch is always
 * named explicitly, so the current HEAD of that checkout is never pushed by
 * accident.
 */
async function pushBranch(root: string, branch: string): Promise<number> {
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
    root,
  );
  if (upstream.code !== 0) {
    process.stdout.write(`push:             git push -u origin ${branch}\n`);
    const pushed = await git(["push", "-u", "origin", branch], root);
    if (pushed.code !== 0) {
      reportFailure(pushed);
      return 1;
    }
    return 0;
  }

  const ahead = await git(
    ["rev-list", "--count", `${upstream.stdout.trim()}..${branch}`],
    root,
  );
  if (ahead.code === 0 && Number.parseInt(ahead.stdout.trim(), 10) > 0) {
    process.stdout.write(`push:             git push origin ${branch}\n`);
    const pushed = await git(["push", "origin", branch], root);
    if (pushed.code !== 0) {
      reportFailure(pushed);
      return 1;
    }
    return 0;
  }

  process.stdout.write(`push:             origin/${branch} is up to date\n`);
  return 0;
}

/**
 * Push the change branch, open its pull request and record it on the board.
 *
 * Idempotent: an open pull request for the branch is recorded instead of a
 * second one being created. `--number <n>` skips creation entirely and records
 * the pull request with that number, which is the way to record a pull request
 * opened from the GitHub web UI on a machine where `gh` cannot create one.
 *
 * The board is written only after `gh pr view` succeeded, so a failing `gh`
 * leaves `board.yaml` untouched and the command can simply be run again.
 */
export async function pr(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const changeId = positional[0];
  if (!changeId) {
    process.stderr.write("usage: change pr <change-id>\n");
    return 2;
  }

  let number: number | null = null;
  if (options.number !== undefined) {
    number = parsePrNumber(options.number);
    if (number === null) {
      process.stderr.write(
        `--number must be a pull request number: ${options.number}\n`,
      );
      return 2;
    }
  }

  const boardPath = resolveBoardPath(options.board);
  const { board, exists } = await loadBoard(boardPath);
  if (!exists) {
    process.stderr.write(`board not found: ${boardPath}\n`);
    return 1;
  }
  const found = findChange(board, changeId);
  if (!found) {
    process.stderr.write(
      `unknown change id: ${changeId} (board: ${boardPath})\n`,
    );
    return 1;
  }

  const branch = found.change.branch;
  if (!branch) {
    process.stderr.write(
      `change ${changeId} has no branch on the board; ` +
        `run "change start ${changeId}" first\n`,
    );
    return 1;
  }

  const root = await mainRepoRoot();
  const base =
    options.base ??
    (await gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();

  process.stdout.write(`base branch:      ${base}\n`);
  process.stdout.write(`head branch:      ${branch}\n`);

  // What `gh pr view` is asked about: a number when one is already known, the
  // branch when the pull request was just created.
  let ref = String(number);

  if (number === null) {
    const pushed = await pushBranch(root, branch);
    if (pushed !== 0) return pushed;

    const listed = await gh(
      ["pr", "list", "--head", branch, "--json", "number"],
      root,
    );
    if (listed.code !== 0) {
      reportFailure(listed);
      return 1;
    }
    const open = parseJson<{ number: number }[]>(listed.stdout.trim() || "[]");
    if (!open) {
      process.stderr.write(`could not read: gh pr list --head ${branch}\n`);
      return 1;
    }

    if (open.length > 0) {
      const existing = open[0]!.number;
      process.stdout.write(
        `pull request:     #${existing} is already open, not creating another\n`,
      );
      ref = String(existing);
    } else {
      process.stdout.write("pull request:     creating a new one\n");
      const created = await gh(
        [
          "pr",
          "create",
          "--base",
          base,
          "--head",
          branch,
          "--title",
          prTitleFor(found.change),
          "--body",
          prBodyFor(found.item, found.change),
        ],
        root,
      );
      if (created.code !== 0) {
        reportFailure(created);
        return 1;
      }
      ref = branch;
    }
  } else {
    process.stdout.write(
      `pull request:     recording existing #${number}, not creating one\n`,
    );
  }

  const viewed = await gh(["pr", "view", ref, "--json", PR_VIEW_FIELDS], root);
  if (viewed.code !== 0) {
    reportFailure(viewed);
    return 1;
  }
  const view = parseJson<PullRequestView>(viewed.stdout);
  if (!view || typeof view.number !== "number") {
    process.stderr.write(`could not read: gh pr view ${ref}\n`);
    return 1;
  }

  // The pull request has to be the one that belongs to this change. Without
  // this check a mistyped `--number` records an unrelated pull request over
  // the correct `pr` record and still exits 0. Checked on both paths: the
  // branch lookup can also return a pull request from a renamed branch.
  if (view.headRefName !== branch) {
    process.stderr.write(
      `pull request #${view.number} is on branch ` +
        `"${view.headRefName ?? "(unknown)"}", not the branch recorded for ` +
        `${changeId} ("${branch}").\n` +
        `Nothing was written to ${boardPath}.\n`,
    );
    return 1;
  }

  const state = normalizePrState(view.state);
  await updateChange(boardPath, changeId, (change) => {
    // `reviewed_sha` belongs to the review commands, not to this one: it stays
    // null on a first record and keeps its value when `pr` is run again.
    const previous = change.pr ?? {};
    change.pr = {
      number: view.number,
      url: view.url ?? null,
      state,
      head_sha: view.headRefOid ?? null,
      reviewed_sha: previous.reviewed_sha ?? null,
    };
    change.state = changeStateForPr(state, change.state);
  });

  process.stdout.write(`pull request:     #${view.number} (${state})\n`);
  process.stdout.write(`board updated:    ${boardPath}\n`);

  process.stdout.write(`${view.url}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: change <command> [options]

commands:
  start <change-id>   create the worktree and branch for a change and record
                      them on the board
  pr <change-id>      push the change branch, open its pull request and record
                      it on the board

options:
  --board <path>      board.yaml, or a project directory containing one
                      (default: $OVERLORD_BOARD, else the current directory)
  --base <branch>     branch to start from, and to merge the pull request into
                      (default: the current branch of the main checkout)
  --number <n>        pr only: record the pull request with this number instead
                      of creating one, for a pull request opened by hand
`;

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "start") return start(argv.slice(1));
  if (command === "pr") return pr(argv.slice(1));
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
