/**
 * The `change` CLI.
 *
 * One change is one worktree, one branch, one pull request and one agent
 * execution unit. This command owns the git side of that contract and records
 * the result on `board.yaml`, so an agent never has to hand-edit the board.
 *
 * Board writes go through the same write path the console server uses
 * (`mutateBoard`), which keeps the YAML key order, the block style, the
 * atomic rename and the `<board>.lock` cross-process lock identical to a
 * console write.
 *
 * Implemented subcommands:
 *   change start    <change-id> [--board <path>] [--base <branch>]
 *   change pr       <change-id> [--board <path>] [--base <branch>] [--number <n>]
 *   change reviewed <change-id> [--board <path>] [--sha <sha>]
 *   change sync     [<card-id>] [--all] [--board <path>]
 *   change deliver  <card-id> [--board <path>] [--base <branch>] [--head <branch>]
 */

import { dirname, resolve } from "node:path";

import {
  boardPathFor,
  canonicalItem,
  loadBoard,
  mutateBoard,
  nowIso,
  type Board,
  type Change,
  type Delivery,
  type Item,
  type PullRequest,
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
 * This bypasses the console server, so it has no client-supplied `rev` to
 * check. It does take the same `<board>.lock` as the server, because the
 * write goes through `mutateBoard`: a console write can no longer land
 * between the load and the save, and a console write already in progress
 * makes this call wait rather than overwrite it.
 *
 * Nothing outside the target change is rewritten; `board.updated_at` is
 * stamped by the write path as it is for every other writer. `mutate` may be
 * called more than once (see `mutateBoard`), so it has to be idempotent.
 */
export async function updateChange(
  boardPath: string,
  changeId: string,
  mutate: (change: Change) => void,
): Promise<Change> {
  const { result } = await mutateBoard(boardPath, undefined, (board) => {
    const found = findChange(board, changeId);
    if (!found) throw new ChangeNotFoundError(changeId);
    mutate(found.change);
    const itemIndex = board.items.indexOf(found.item);
    if (itemIndex >= 0) board.items[itemIndex] = canonicalItem(found.item);
    return found.change;
  });
  return result;
}

/**
 * Read the board, mutate several changes, write the board back once.
 *
 * `sync` reads many pull requests in one run, and every board write makes the
 * console re-render, so the whole run must land as a single write. The
 * concurrency safety is the same as `updateChange`: one `mutateBoard` call,
 * so one lock, one load and one save for the whole set.
 *
 * An empty id list writes nothing at all, so a run that found no update
 * leaves the file, and the console, untouched. An unknown id throws from
 * inside the mutation, which aborts the write: either every named change is
 * written or none is.
 */
export async function updateChanges(
  boardPath: string,
  changeIds: string[],
  mutate: (change: Change) => void,
): Promise<void> {
  if (changeIds.length === 0) return;

  await mutateBoard(boardPath, undefined, (board) => {
    const touched: Item[] = [];
    for (const changeId of changeIds) {
      const found = findChange(board, changeId);
      if (!found) throw new ChangeNotFoundError(changeId);
      mutate(found.change);
      if (!touched.includes(found.item)) touched.push(found.item);
    }
    for (const item of touched) {
      const index = board.items.indexOf(item);
      if (index >= 0) board.items[index] = canonicalItem(item);
    }
  });
}

export class ItemNotFoundError extends Error {
  constructor(readonly itemId: string) {
    super(`unknown card id: ${itemId}`);
    this.name = "ItemNotFoundError";
  }
}

/** Resolve a card id on the board. Exact match on `items[].id`. */
export function findItem(board: Board, itemId: string): Item | null {
  return board.items.find((item) => item?.id === itemId) ?? null;
}

/**
 * Read the board, mutate one card, write the board back.
 *
 * The card-level counterpart of `updateChange`, with the same concurrency
 * properties: one `mutateBoard` call, so the same `<board>.lock`, and the same
 * `canonicalItem` pass so the key order survives. `mutate` may be called more
 * than once (see `mutateBoard`), so anything derived from the clock has to be
 * computed by the caller and closed over rather than read inside it.
 */
export async function updateItem(
  boardPath: string,
  itemId: string,
  mutate: (item: Item) => void,
): Promise<Item> {
  const { result } = await mutateBoard(boardPath, undefined, (board) => {
    const index = board.items.findIndex((item) => item?.id === itemId);
    if (index < 0) throw new ItemNotFoundError(itemId);
    const item = board.items[index]!;
    mutate(item);
    board.items[index] = canonicalItem(item);
    return board.items[index]!;
  });
  return result;
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

/**
 * `code` for a command that never produced an exit status of its own: the
 * executable could not be spawned, or the run was killed at `timeoutMs`. It is
 * outside the 0-255 range a process can exit with, so it cannot collide with a
 * real status, and every caller already treats "not 0" as a failure.
 */
export const RUN_FAILED = -1;

/**
 * Run a command and collect its output.
 *
 * Two failure modes are turned into a `RunResult` rather than an exception,
 * because `deliverCard` is called from the console server, where an unhandled
 * rejection would take down a request handler:
 *
 *   - `Bun.spawn` throws synchronously when the executable is not on the PATH
 *     (no `gh` installed, for instance);
 *   - a command that never finishes would otherwise hang the caller for ever,
 *     so `timeoutMs` kills it and reports `RUN_FAILED`.
 *
 * Without a `timeoutMs` the call waits as long as the command takes, which is
 * what the CLI subcommands want.
 */
export async function run(
  command: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      cwd,
      // A copy of the current environment rather than the default: Bun resolves
      // the executable against the PATH of the environment it is handed, and the
      // default is the environment the process was started with, so a PATH set
      // after startup would otherwise be ignored.
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (error) {
    return {
      code: RUN_FAILED,
      stdout: "",
      stderr: `${command.join(" ")}: ${(error as Error).message}\n`,
    };
  }

  let timedOut = false;
  const timer =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs)
      : null;

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timedOut) {
      return {
        code: RUN_FAILED,
        stdout,
        stderr: `${stderr}${command.join(" ")}: timed out after ${timeoutMs}ms\n`,
      };
    }
    return { code, stdout, stderr };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function runOrThrow(
  command: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  const result = await run(command, cwd, timeoutMs);
  if (result.code !== 0) throw new CommandError(command, result);
  return result;
}

export function git(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  return run(["git", ...args], cwd, timeoutMs);
}

export function gitOrThrow(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  return runOrThrow(["git", ...args], cwd, timeoutMs);
}

export function gh(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  return run(["gh", ...args], cwd, timeoutMs);
}

export function ghOrThrow(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  return runOrThrow(["gh", ...args], cwd, timeoutMs);
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
export async function mainRepoRoot(
  cwd?: string,
  timeoutMs?: number,
): Promise<string> {
  const result = await gitOrThrow(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
    timeoutMs,
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

/**
 * Split `--key value` options out of an argument list.
 *
 * Names listed in `booleans` are flags: they take no value, never swallow the
 * next argument, and are recorded as `"true"` so the option map stays a plain
 * string map.
 */
export function parseArgs(argv: string[], booleans: string[] = []): ParsedArgs {
  const flags = new Set(booleans);
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
    const name = arg.slice(2);
    if (flags.has(name)) {
      options[name] = "true";
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option ${arg} needs a value`);
    }
    options[name] = value;
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

/** A failed command's own diagnostics, so they are never paraphrased. */
function failureMessage(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

/** Show a failed command's own diagnostics instead of paraphrasing them. */
function reportFailure(result: RunResult): void {
  const message = failureMessage(result);
  if (message) process.stderr.write(`${message}\n`);
}

/**
 * What `pushBranch` did. Returned rather than printed, because `deliverCard`
 * has to stay silent on both streams: it is called from the console server,
 * which owns its own output.
 */
export type PushOutcome = {
  ok: boolean;
  /** Progress lines the CLI prints on stdout. */
  lines: string[];
  /** The failing command's own diagnostics, or null when the push worked. */
  error: string | null;
};

/**
 * Make sure `origin/<branch>` exists and carries the local commits.
 *
 * This runs in the main repository rather than in the change worktree, so it
 * works whichever checkout the command was started from. The branch is always
 * named explicitly, so the current HEAD of that checkout is never pushed by
 * accident.
 */
async function pushBranch(
  root: string,
  branch: string,
  timeoutMs?: number,
): Promise<PushOutcome> {
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
    root,
    timeoutMs,
  );
  if (upstream.code !== 0) {
    const lines = [`push:             git push -u origin ${branch}`];
    const pushed = await git(["push", "-u", "origin", branch], root, timeoutMs);
    if (pushed.code !== 0) {
      return { ok: false, lines, error: failureMessage(pushed) };
    }
    return { ok: true, lines, error: null };
  }

  const ahead = await git(
    ["rev-list", "--count", `${upstream.stdout.trim()}..${branch}`],
    root,
    timeoutMs,
  );
  if (ahead.code === 0 && Number.parseInt(ahead.stdout.trim(), 10) > 0) {
    const lines = [`push:             git push origin ${branch}`];
    const pushed = await git(["push", "origin", branch], root, timeoutMs);
    if (pushed.code !== 0) {
      return { ok: false, lines, error: failureMessage(pushed) };
    }
    return { ok: true, lines, error: null };
  }

  return {
    ok: true,
    lines: [`push:             origin/${branch} is up to date`],
    error: null,
  };
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
    for (const line of pushed.lines) process.stdout.write(`${line}\n`);
    if (!pushed.ok) {
      if (pushed.error) process.stderr.write(`${pushed.error}\n`);
      return 1;
    }

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
// reviewed
// ---------------------------------------------------------------------------

/**
 * Parse a git commit sha.
 *
 * `reviewed_sha` is the commit an independent reviewer actually read, and it is
 * later compared with the pull request head, so a value that is not a commit
 * name would silently turn that comparison into a permanent mismatch. A full
 * object name is 40 hex digits; an abbreviated one is accepted from 7 digits
 * up, which is git's own lower bound for an unambiguous short name.
 *
 * The value is lower-cased, because git object names are lower-case hex and the
 * comparison with `head_sha` is a string comparison.
 *
 * Returns null for anything that is not a commit name.
 */
export function parseSha(raw: string): string | null {
  if (!/^[0-9a-fA-F]{7,40}$/.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Whether two recorded shas name the same commit.
 *
 * `reviewed_sha` may be an abbreviation (`--sha 1a2b3c4`) while `head_sha` is
 * always the full object name `gh` reports, so a plain string comparison would
 * report a review gap that does not exist. One being a prefix of the other is
 * the same commit for this purpose; both are at least 7 digits, so a prefix
 * collision is not a practical concern.
 */
export function sameCommit(a: string, b: string): boolean {
  const first = a.toLowerCase();
  const second = b.toLowerCase();
  const [shorter, longer] =
    first.length <= second.length ? [first, second] : [second, first];
  return longer.startsWith(shorter);
}

/** The full HEAD commit of one worktree, or null when it cannot be read. */
async function worktreeHead(
  root: string,
  worktree: string,
): Promise<string | null> {
  const worktrees = parseWorktreePaths(
    (await gitOrThrow(["worktree", "list", "--porcelain"], root)).stdout,
  );
  if (!worktrees.includes(worktree)) return null;
  const head = await git(["-C", worktree, "rev-parse", "HEAD"], root);
  if (head.code !== 0) return null;
  return parseSha(head.stdout.trim());
}

/**
 * Record the commit an independent review actually read.
 *
 * The review is done on a worktree, so the worktree HEAD is the commit that was
 * read; the pull request head is used only when the worktree is already gone,
 * which is the case when the review runs after the worktree was removed. Both
 * are read, never guessed: `--sha` is the way to record a commit that is
 * neither.
 *
 * The change must already carry a pull request, because `reviewed_sha` lives
 * inside `pr` and is meaningless without the pull request it qualifies. The
 * board is written only after the commit is known, so a failure leaves
 * `board.yaml` untouched.
 */
export async function reviewed(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const changeId = positional[0];
  if (!changeId) {
    process.stderr.write("usage: change reviewed <change-id> [--sha <sha>]\n");
    return 2;
  }

  let sha: string | null = null;
  if (options.sha !== undefined) {
    sha = parseSha(options.sha);
    if (sha === null) {
      process.stderr.write(
        `--sha must be a commit sha of 7 to 40 hex digits: ${options.sha}\n`,
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

  const number = found.change.pr?.number;
  if (typeof number !== "number") {
    process.stderr.write(
      `change ${changeId} has no pull request on the board; ` +
        `run "change pr ${changeId}" first.\n` +
        `Nothing was written to ${boardPath}.\n`,
    );
    return 1;
  }

  let source = "--sha";
  if (sha === null) {
    const root = await mainRepoRoot();
    const worktree = worktreePathFor(root, changeId);
    sha = await worktreeHead(root, worktree);
    if (sha !== null) {
      source = worktree;
    } else {
      const viewed = await gh(
        ["pr", "view", String(number), "--json", "headRefOid"],
        root,
      );
      if (viewed.code !== 0) {
        reportFailure(viewed);
        return 1;
      }
      const view = parseJson<{ headRefOid?: unknown }>(viewed.stdout);
      const headRefOid =
        typeof view?.headRefOid === "string" ? view.headRefOid : "";
      sha = headRefOid ? parseSha(headRefOid) : null;
      if (sha === null) {
        process.stderr.write(
          `could not read: gh pr view ${number} --json headRefOid\n`,
        );
        return 1;
      }
      source = `gh pr view ${number}`;
    }
  }

  await updateChange(boardPath, changeId, (change) => {
    // Only `reviewed_sha` moves: the rest of the record belongs to `pr` and to
    // `sync`, and this command must not overwrite what they last read.
    change.pr = { ...(change.pr ?? {}), reviewed_sha: sha };
  });

  process.stdout.write(`pull request:     #${number}\n`);
  process.stdout.write(`reviewed commit:  ${sha}\n`);
  process.stdout.write(`read from:        ${source}\n`);
  process.stdout.write(`board updated:    ${boardPath}\n`);

  process.stdout.write(`${sha}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

/**
 * Changes `sync` can read: those that already carry a pull request number.
 *
 * A change whose `pr` is still null has never been pushed, so there is nothing
 * to ask GitHub about and it is skipped rather than reported as a failure.
 */
export function syncTargets(items: Item[]): FoundChange[] {
  const targets: FoundChange[] = [];
  for (const item of items) {
    const changes = item.changes;
    if (!Array.isArray(changes)) continue;
    changes.forEach((change, index) => {
      if (!change) return;
      if (typeof change.pr?.number !== "number") return;
      targets.push({ item, change, index });
    });
  }
  return targets;
}

/** What one `gh pr view` result did to one change. */
export type SyncOutcome = {
  /** Whether anything on the change actually moved. */
  changed: boolean;
  /** Pull request state on the board before this run. */
  previousState: string | null;
  /** Pull request state after this run. */
  state: string | null;
  /** Whether this run moved the change itself to `done`. */
  changeDone: boolean;
};

/**
 * Write one `gh pr view` result onto one change and report what moved.
 *
 * `merged` is the only pull request state that decides the change is finished.
 * A `closed` pull request leaves `change.state` alone on purpose: closing can
 * mean abandoned, superseded or reopened next, and that call belongs to the
 * commander, not to a status poll.
 *
 * `reviewed_sha` belongs to the review commands and is carried over unchanged,
 * the same way `pr` treats it. The function only touches the change it is
 * given and reads nothing else, so it is safe to re-apply after a reload.
 */
export function applyPullRequestView(
  change: Change,
  view: PullRequestView,
): SyncOutcome {
  const previous = change.pr ?? {};
  const previousState = previous.state ?? null;
  const state = normalizePrState(view.state);
  const url = view.url ?? previous.url ?? null;
  const headSha = view.headRefOid ?? previous.head_sha ?? null;

  const prMoved =
    state !== previousState ||
    url !== (previous.url ?? null) ||
    headSha !== (previous.head_sha ?? null);
  const changeDone = state === "merged" && change.state !== "done";

  change.pr = {
    number: view.number,
    url,
    state,
    head_sha: headSha,
    reviewed_sha: previous.reviewed_sha ?? null,
  };
  if (changeDone) change.state = "done";

  return { changed: prMoved || changeDone, previousState, state, changeDone };
}

/**
 * The warning for a change whose pull request grew commits after it was
 * reviewed, or null when there is nothing to warn about.
 *
 * This is a warning, not an error: commits after a review are normal while the
 * change is still being worked on. It matters at merge time, which is why it is
 * reported on every `sync` rather than only when the pull request moved.
 *
 * Nothing is reported while either commit is unknown, because "not recorded"
 * and "not reviewed" are different states and only the reviewer can tell them
 * apart.
 */
export function reviewGapLine(
  changeId: string,
  headSha: string | null | undefined,
  reviewedSha: string | null | undefined,
): string | null {
  if (!headSha || !reviewedSha) return null;
  if (sameCommit(headSha, reviewedSha)) return null;
  return (
    `${changeId}: commits were added after the review ` +
    `(reviewed ${reviewedSha}, head ${headSha}); ` +
    `review the new commits before merging`
  );
}

/** One reported line: `OV-103-C2  open -> merged  (change done)`. */
export function syncLine(changeId: string, outcome: SyncOutcome): string {
  const from = outcome.previousState ?? "unknown";
  const to = outcome.state ?? "unknown";
  const done = outcome.changeDone ? "  (change done)" : "";
  return `${changeId}  ${from} -> ${to}${done}`;
}

/**
 * Read the pull request state of every recorded change and write it back.
 *
 * One run reads many pull requests but writes `board.yaml` exactly once, so
 * the console re-renders once per run instead of once per change. Only the
 * changes that actually moved are written, so a run that found nothing new
 * leaves the file untouched.
 *
 * A `gh` failure on one change is reported and skipped; the remaining changes
 * are still synchronized and still written, and the command then exits
 * non-zero so the caller knows the picture is incomplete. A pull request that
 * is not on the branch recorded for the change is skipped the same way, so a
 * wrong `pr.number` cannot import another pull request's state.
 */
export async function sync(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["all"]);
  const cardId = positional[0] ?? null;
  const all = options.all === "true";
  if (!cardId && !all) {
    process.stderr.write("usage: change sync [<card-id>] [--all]\n");
    return 2;
  }
  if (cardId && all) {
    process.stderr.write(
      `sync takes a card id or --all, not both: ${cardId} --all\n`,
    );
    return 2;
  }

  const boardPath = resolveBoardPath(options.board);
  const { board, exists } = await loadBoard(boardPath);
  if (!exists) {
    process.stderr.write(`board not found: ${boardPath}\n`);
    return 1;
  }

  let items = board.items;
  if (cardId) {
    const item = board.items.find((candidate) => candidate.id === cardId);
    if (!item) {
      process.stderr.write(
        `unknown card id: ${cardId} (board: ${boardPath})\n`,
      );
      return 1;
    }
    items = [item];
  }

  const targets = syncTargets(items);
  if (targets.length === 0) {
    process.stdout.write("no change has a pull request to read\n");
    return 0;
  }

  const root = await mainRepoRoot();
  const views = new Map<string, PullRequestView>();
  let failures = 0;

  for (const target of targets) {
    const number = target.change.pr!.number!;
    const viewed = await gh(
      ["pr", "view", String(number), "--json", PR_VIEW_FIELDS],
      root,
    );
    if (viewed.code !== 0) {
      process.stderr.write(
        `${target.change.id}: gh pr view ${number} failed\n`,
      );
      reportFailure(viewed);
      failures += 1;
      continue;
    }
    const view = parseJson<PullRequestView>(viewed.stdout);
    if (!view || typeof view.number !== "number") {
      process.stderr.write(
        `${target.change.id}: could not read: gh pr view ${number}\n`,
      );
      failures += 1;
      continue;
    }
    views.set(target.change.id, view);
  }

  // Applied to the copy loaded above only to find out what moved and to build
  // the report. The file on disk is written once, below, and only for the
  // changes that moved.
  const lines: string[] = [];
  const moved: string[] = [];
  for (const target of targets) {
    const view = views.get(target.change.id);
    if (!view) continue;

    // The pull request has to be the one that belongs to this change, exactly
    // as `pr` requires when it records the number. Without this check a wrong
    // `pr.number` — a typo, or a number recorded before a branch was renamed —
    // imports an unrelated pull request's state, and its merge would move the
    // change to `done`. Skipped and counted as a failure: the change's real
    // state is unknown, so nothing is written for it.
    const branch = target.change.branch ?? null;
    if (!branch || view.headRefName !== branch) {
      process.stderr.write(
        `${target.change.id}: pull request #${view.number} is on branch ` +
          `"${view.headRefName ?? "(unknown)"}", not the branch recorded for ` +
          `the change ("${branch ?? "(none)"}"); skipped, nothing written\n`,
      );
      views.delete(target.change.id);
      failures += 1;
      continue;
    }

    const outcome = applyPullRequestView(target.change, view);

    // Reported whether or not the pull request moved: the gap is a property of
    // the change, not of this run.
    const gap = reviewGapLine(
      target.change.id,
      target.change.pr?.head_sha,
      target.change.pr?.reviewed_sha,
    );
    if (gap) process.stderr.write(`${gap}\n`);

    if (!outcome.changed) continue;
    moved.push(target.change.id);
    lines.push(syncLine(target.change.id, outcome));
  }

  if (moved.length === 0) {
    if (failures > 0) {
      // Not "already current": a change that could not be read was not
      // compared with anything, so the board's pull request state is unknown,
      // and a caller reading only this line must not conclude it is complete.
      process.stdout.write(
        `${failures} of ${targets.length} pull requests could not be read; ` +
          "nothing was written and the board is not known to be current\n",
      );
      return 1;
    }
    process.stdout.write(
      "no pull request moved; the board is already current\n",
    );
    return 0;
  }

  await updateChanges(boardPath, moved, (change) => {
    const view = views.get(change.id);
    if (view) applyPullRequestView(change, view);
  });

  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write(`board updated:    ${boardPath}\n`);
  return failures > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// deliver
// ---------------------------------------------------------------------------

/** Title of the delivery pull request: the card title with its id appended. */
export function deliveryTitleFor(item: Item): string {
  return `${item.title} (${item.id})`;
}

/**
 * The delivery pull request section for one card.
 *
 * It has to say what a reviewer of the default branch needs without opening
 * the board: what the card is, what it was accepted against, and which change
 * pull requests it is made of. A change with no pull request is listed as
 * such rather than omitted, so a card cannot look complete because a piece of
 * it was never pushed.
 */
export function deliveryBodyFor(item: Item): string {
  const lines: string[] = [item.title, "", `Card: ${item.id}`, "", "受け入れ条件:"];

  const conditions = Array.isArray(item.acceptance_conditions)
    ? item.acceptance_conditions
    : [];
  if (conditions.length === 0) lines.push("- (board に記録なし)");
  else for (const condition of conditions) lines.push(`- ${condition}`);

  lines.push("", "Changes:");
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) {
    lines.push("- (board に記録なし)");
  } else {
    for (const change of changes) {
      const number = change.pr?.number;
      const url = change.pr?.url;
      const pullRequest =
        typeof number === "number" ? `#${number}${url ? ` ${url}` : ""}` : "PR 無し";
      lines.push(
        `- ${change.id}  ${change.title}  (${change.state})  ${pullRequest}`,
      );
    }
  }

  return lines.join("\n");
}

/** Opening marker of one card's section inside a delivery pull request body. */
export function deliveryStartMarker(cardId: string): string {
  return `<!-- overlord:card ${cardId} -->`;
}

/** Closing marker of one card's section inside a delivery pull request body. */
export function deliveryEndMarker(cardId: string): string {
  return `<!-- /overlord:card ${cardId} -->`;
}

/**
 * Put one card's section into a pull request body, replacing its previous one.
 *
 * A delivery pull request is opened per card, but one branch can carry several
 * cards, and the same card is delivered again whenever its changes move. The
 * section is therefore fenced by HTML comment markers that carry the card id:
 * re-delivering the same card rewrites its own fenced section and leaves every
 * other card's section, and any text a person wrote around them, exactly as it
 * was. A body that does not carry this card's markers yet gets the section
 * appended.
 */
export function mergeDeliveryBody(
  existingBody: string | null | undefined,
  cardId: string,
  section: string,
): string {
  const start = deliveryStartMarker(cardId);
  const end = deliveryEndMarker(cardId);
  const block = `${start}\n${section.replace(/\s+$/, "")}\n${end}`;
  const existing = existingBody ?? "";

  const from = existing.indexOf(start);
  const to = from < 0 ? -1 : existing.indexOf(end, from + start.length);
  if (from >= 0 && to >= 0) {
    return existing.slice(0, from) + block + existing.slice(to + end.length);
  }

  const head = existing.replace(/\s+$/, "");
  return head ? `${head}\n\n${block}\n` : `${block}\n`;
}

/**
 * The changes of a card that are not merged yet.
 *
 * `done` is the only change state that means the pull request is merged;
 * `reviewing` and `blocked` both mean work is still open, and a `closed` pull
 * request leaves the change wherever the commander put it. A card with no
 * changes at all has nothing unmerged.
 */
export function unmergedChanges(item: Item): Change[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.filter((change) => change && change.state !== "done");
}

/** `gh pr view` fields the delivery pull request is verified against. */
export type DeliveryView = PullRequestView & { baseRefName: string };

const DELIVERY_VIEW_FIELDS =
  "number,url,state,headRefOid,headRefName,baseRefName";

export type DeliverOptions = {
  boardPath: string;
  cardId: string;
  /** Directory to resolve the repository from; the process cwd by default. */
  cwd?: string;
  /** Branch to merge into; resolved from the repository when not given. */
  base?: string | null;
  /** Branch to deliver; the current branch of the main checkout by default. */
  head?: string | null;
  /** Per-command timeout for every git and `gh` call. */
  timeoutMs?: number;
};

export type DeliverOutcome = {
  status: "created" | "updated" | "skipped" | "blocked" | "failed";
  /** Why the run ended this way; absent when there is nothing to explain. */
  reason?: string;
  /** The delivery pull request, as it was written to the board. */
  pr?: PullRequest;
  /** `<change-id>  <title>` for every change that is not merged yet. */
  unmerged?: string[];
  /** Non-fatal problems: the run continued in spite of them. */
  warnings: string[];
};

/**
 * The branch a delivery pull request merges into.
 *
 * `origin/HEAD` is what the repository itself says the default branch is, so
 * it is asked first and costs no network call. It is a local symbolic ref that
 * only exists once something set it (`git clone` does, `git init` does not), so
 * GitHub is asked next, and `main` is the last resort rather than an error:
 * a wrong base is caught by the `baseRefName` check before anything is
 * written to the board.
 */
export async function resolveDeliveryBase(
  root: string,
  timeoutMs?: number,
): Promise<string> {
  const symbolic = await git(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    root,
    timeoutMs,
  );
  if (symbolic.code === 0) {
    // `origin/main` -> `main`: the remote name is a prefix of the short form.
    const value = symbolic.stdout.trim();
    const slash = value.indexOf("/");
    const branch = slash >= 0 ? value.slice(slash + 1) : value;
    if (branch) return branch;
  }

  const viewed = await gh(
    ["repo", "view", "--json", "defaultBranchRef"],
    root,
    timeoutMs,
  );
  if (viewed.code === 0) {
    const parsed = parseJson<{ defaultBranchRef?: { name?: unknown } }>(
      viewed.stdout,
    );
    const name = parsed?.defaultBranchRef?.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }

  return "main";
}

/**
 * Deliver one finished card to the repository default branch.
 *
 * Writes nothing to stdout or stderr: everything it did is in the returned
 * `DeliverOutcome`, so the console server can call it from a request handler
 * and the CLI wrapper can print it.
 *
 * The order of the steps is the point of the command:
 *
 *  1. every change pull request is synchronized first, so the merge state the
 *     block decision is made on is GitHub's, not whatever the board last
 *     recorded. Without this, a card whose changes were merged in the web UI
 *     would be reported as unmergeable;
 *  2. a card with any unmerged change is refused before a pull request exists
 *     and before the board records a delivery, so a half-finished card cannot
 *     be proposed for the default branch by accident;
 *  3. the pull request is only recorded after `gh pr view` confirmed that it
 *     really is `head -> base`. A failure at any step therefore leaves
 *     `board.yaml` exactly as it was and the command can be run again.
 *
 * A base that has moved on while the card was in flight is reported as a
 * warning and nothing more: the delivery is not stopped and the base is not
 * merged into the head, because the pull request is where the two branches
 * meet and merging on the agent's behalf would rewrite work nobody reviewed.
 *
 * Idempotent: an open pull request for the same head and base is edited rather
 * than a second one created, and its title is left alone because a person may
 * have renamed it. A head that is already identical to the base is reported as
 * skipped instead of producing an empty pull request.
 */
export async function deliverCard(
  options: DeliverOptions,
): Promise<DeliverOutcome> {
  const { boardPath, cardId, cwd, timeoutMs } = options;
  const warnings: string[] = [];

  const loaded = await loadBoard(boardPath);
  if (!loaded.exists) {
    return { status: "failed", reason: `board not found: ${boardPath}`, warnings };
  }
  const item = findItem(loaded.board, cardId);
  if (!item) {
    return {
      status: "failed",
      reason: `unknown card id: ${cardId} (board: ${boardPath})`,
      warnings,
    };
  }

  let root: string;
  try {
    root = await mainRepoRoot(cwd, timeoutMs);
  } catch (error) {
    return {
      status: "failed",
      reason: `could not resolve the repository root: ${(error as Error).message}`,
      warnings,
    };
  }

  // 1. Synchronize this card's change pull requests before deciding anything.
  const synced = await syncCardChanges(boardPath, item, root, timeoutMs);
  warnings.push(...synced);

  // 2. Refuse a card that is not finished, before creating or writing anything.
  const unmerged = unmergedChanges(item);
  if (unmerged.length > 0) {
    return {
      status: "blocked",
      reason:
        `${unmerged.length} of ${item.changes?.length ?? 0} changes of ` +
        `${cardId} are not merged`,
      unmerged: unmerged.map((change) => `${change.id}  ${change.title}`),
      warnings,
    };
  }

  // 3. Head: the branch the card's work sits on.
  let head = options.head?.trim() || null;
  if (!head) {
    const current = await git(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      root,
      timeoutMs,
    );
    if (current.code !== 0) {
      return {
        status: "failed",
        reason: `could not read the current branch: ${failureMessage(current)}`,
        warnings,
      };
    }
    head = current.stdout.trim();
    if (!head || head === "HEAD") {
      return {
        status: "failed",
        reason:
          `${root} has a detached HEAD, so there is no branch to deliver; ` +
          "pass --head <branch>",
        warnings,
      };
    }
  }

  const base = options.base?.trim() || (await resolveDeliveryBase(root, timeoutMs));

  if (head === base) {
    return {
      status: "skipped",
      reason: "same-branch",
      warnings,
    };
  }

  // 4. Bring `origin/<base>` up to date so the diff below is against what the
  //    pull request would actually merge into. A failure here only makes the
  //    comparison older, so it is a warning and the run continues.
  const fetched = await git(["fetch", "origin", base], root, timeoutMs);
  if (fetched.code !== 0) {
    warnings.push(
      `git fetch origin ${base} failed; comparing against the ref already ` +
        `in this repository: ${failureMessage(fetched)}`,
    );
  }

  // 5. Nothing to propose is not a failure: the branch is already delivered,
  //    or the work landed some other way.
  const remoteRef = `origin/${base}`;
  const hasRemoteRef =
    (
      await git(
        ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`],
        root,
        timeoutMs,
      )
    ).code === 0;
  const diffBase = hasRemoteRef ? remoteRef : base;
  const diff = await git(["diff", "--quiet", diffBase, head], root, timeoutMs);
  if (diff.code === 0) {
    return { status: "skipped", reason: "no-diff", warnings };
  }
  // `git diff --quiet` exits 1 for "there are differences" and above 1 for a
  // real error, which must not be read as a difference.
  if (diff.code !== 1) {
    return {
      status: "failed",
      reason: `git diff ${diffBase} ${head} failed: ${failureMessage(diff)}`,
      warnings,
    };
  }

  // 6. Report what the base holds that the head does not. This never changes
  //    the outcome: the pull request is where the two branches meet.
  warnings.push(...(await baseGapWarnings(root, diffBase, head, timeoutMs)));

  const push = await pushBranch(root, head, timeoutMs);
  if (!push.ok) {
    return {
      status: "failed",
      reason: push.error || `git push origin ${head} failed`,
      warnings,
    };
  }

  // 7. Reuse the pull request already open for this head and base.
  const listed = await gh(
    [
      "pr",
      "list",
      "--head",
      head,
      "--base",
      base,
      "--state",
      "open",
      "--json",
      "number,url",
    ],
    root,
    timeoutMs,
  );
  if (listed.code !== 0) {
    return {
      status: "failed",
      reason: `gh pr list --head ${head} failed: ${failureMessage(listed)}`,
      warnings,
    };
  }
  const open = parseJson<{ number: number }[]>(listed.stdout.trim() || "[]");
  if (!open || !Array.isArray(open)) {
    return {
      status: "failed",
      reason: `could not read: gh pr list --head ${head} --base ${base}`,
      warnings,
    };
  }

  const section = deliveryBodyFor(item);
  let status: "created" | "updated";
  let ref: string;

  if (open.length > 0 && typeof open[0]!.number === "number") {
    const number = open[0]!.number;
    // Read the body first: the card's section replaces its own previous one and
    // leaves everything else in place, so it cannot be merged blind.
    const body = await gh(
      ["pr", "view", String(number), "--json", "body"],
      root,
      timeoutMs,
    );
    let existingBody = "";
    if (body.code !== 0) {
      warnings.push(
        `gh pr view ${number} --json body failed; the body is rewritten from ` +
          `the board alone: ${failureMessage(body)}`,
      );
    } else {
      const parsed = parseJson<{ body?: unknown }>(body.stdout);
      existingBody = typeof parsed?.body === "string" ? parsed.body : "";
    }

    // The title is deliberately not passed: a person may have renamed the
    // pull request, and re-delivering a card must not undo that.
    const edited = await gh(
      [
        "pr",
        "edit",
        String(number),
        "--body",
        mergeDeliveryBody(existingBody, cardId, section),
      ],
      root,
      timeoutMs,
    );
    if (edited.code !== 0) {
      return {
        status: "failed",
        reason: `gh pr edit ${number} failed: ${failureMessage(edited)}`,
        warnings,
      };
    }
    status = "updated";
    ref = String(number);
  } else {
    const created = await gh(
      [
        "pr",
        "create",
        "--base",
        base,
        "--head",
        head,
        "--title",
        deliveryTitleFor(item),
        "--body",
        mergeDeliveryBody("", cardId, section),
      ],
      root,
      timeoutMs,
    );
    if (created.code !== 0) {
      return {
        status: "failed",
        reason: `gh pr create failed: ${failureMessage(created)}`,
        warnings,
      };
    }
    status = "created";
    ref = head;
  }

  // 8. Verify before writing: the pull request has to be this head against
  //    this base. `gh pr list --head` matches on the branch name alone, which
  //    a fork or a renamed branch can satisfy with someone else's pull request.
  const viewed = await gh(
    ["pr", "view", ref, "--json", DELIVERY_VIEW_FIELDS],
    root,
    timeoutMs,
  );
  if (viewed.code !== 0) {
    return {
      status: "failed",
      reason: `gh pr view ${ref} failed: ${failureMessage(viewed)}`,
      warnings,
    };
  }
  const view = parseJson<DeliveryView>(viewed.stdout);
  if (!view || typeof view.number !== "number") {
    return {
      status: "failed",
      reason: `could not read: gh pr view ${ref}`,
      warnings,
    };
  }
  if (view.headRefName !== head || view.baseRefName !== base) {
    return {
      status: "failed",
      reason:
        `pull request #${view.number} is ` +
        `"${view.headRefName ?? "(unknown)"}" -> ` +
        `"${view.baseRefName ?? "(unknown)"}", not "${head}" -> "${base}". ` +
        `Nothing was written to ${boardPath}.`,
      warnings,
    };
  }

  const pullRequest: PullRequest = {
    number: view.number,
    url: view.url ?? null,
    state: normalizePrState(view.state),
    head_sha: view.headRefOid ?? null,
    // The review happened on the changes; the delivery pull request carries
    // no review of its own.
    reviewed_sha: null,
  };
  // Read once, outside the mutation: `mutateBoard` may apply it twice, and a
  // timestamp read inside would differ between the two passes.
  const attemptedAt = nowIso();
  const delivery: Delivery = {
    branch: head,
    base,
    pr: pullRequest,
    error: null,
    attempted_at: attemptedAt,
  };
  await updateItem(boardPath, cardId, (target) => {
    target.delivery = delivery;
  });

  return { status, pr: pullRequest, warnings };
}

/**
 * Synchronize the change pull requests of one card and return the warnings.
 *
 * The same read-and-apply `sync` performs, narrowed to one card and reporting
 * instead of printing. `item` is mutated in place as well as written, so the
 * caller's merge decision is made on the state just read from GitHub rather
 * than on the board copy it loaded a moment earlier.
 *
 * A pull request that could not be read, or that is not on the branch recorded
 * for the change, is a warning and leaves the change exactly as the board has
 * it: not merged, so the card is blocked rather than delivered on a guess.
 */
async function syncCardChanges(
  boardPath: string,
  item: Item,
  root: string,
  timeoutMs?: number,
): Promise<string[]> {
  const warnings: string[] = [];
  const targets = syncTargets([item]);
  if (targets.length === 0) return warnings;

  const views = new Map<string, PullRequestView>();
  for (const target of targets) {
    const number = target.change.pr!.number!;
    const viewed = await gh(
      ["pr", "view", String(number), "--json", PR_VIEW_FIELDS],
      root,
      timeoutMs,
    );
    if (viewed.code !== 0) {
      warnings.push(
        `${target.change.id}: gh pr view ${number} failed: ${failureMessage(viewed)}`,
      );
      continue;
    }
    const view = parseJson<PullRequestView>(viewed.stdout);
    if (!view || typeof view.number !== "number") {
      warnings.push(`${target.change.id}: could not read: gh pr view ${number}`);
      continue;
    }
    const branch = target.change.branch ?? null;
    if (!branch || view.headRefName !== branch) {
      warnings.push(
        `${target.change.id}: pull request #${view.number} is on branch ` +
          `"${view.headRefName ?? "(unknown)"}", not the branch recorded for ` +
          `the change ("${branch ?? "(none)"}"); skipped, nothing written`,
      );
      continue;
    }
    views.set(target.change.id, view);
  }

  const moved: string[] = [];
  for (const target of targets) {
    const view = views.get(target.change.id);
    if (!view) continue;
    if (applyPullRequestView(target.change, view).changed) {
      moved.push(target.change.id);
    }
    const gap = reviewGapLine(
      target.change.id,
      target.change.pr?.head_sha,
      target.change.pr?.reviewed_sha,
    );
    if (gap) warnings.push(gap);
  }

  if (moved.length > 0) {
    await updateChanges(boardPath, moved, (change) => {
      const view = views.get(change.id);
      if (view) applyPullRequestView(change, view);
    });
  }

  return warnings;
}

/**
 * How many conflicted paths the conflict warning names before it stops and
 * counts the rest.
 *
 * The warning already carries the total, so the list only has to say where the
 * conflict is. Five paths keep the line about as long as the other warnings
 * even when the paths are long, and the full list is one `git merge-tree` away.
 */
const MAX_NAMED_CONFLICT_PATHS = 5;

/**
 * Report the commits `base` holds that `head` does not, and whether they
 * conflict, as warnings.
 *
 * Two separate questions, answered by two commands, because the answers are
 * not the same information:
 *
 *  - "has the base moved on since the head branched off?" is
 *    `git merge-base --is-ancestor <base> <head>`. Exit 0 means the base is
 *    contained in the head, which is the ordinary state of a branch that was
 *    kept up to date, and produces no warning at all. Exit 1 means it is not,
 *    and the number of commits is read separately so the warning names it;
 *  - "would merging them conflict?" is `git merge-tree --write-tree`, which
 *    merges the two commits in memory without touching the working tree. Exit
 *    0 is a clean merge. A non-zero exit with the merged tree object on stdout
 *    is a conflict, and the conflicted paths follow it, one per line, up to
 *    the first blank line. A non-zero exit with nothing on stdout is the
 *    command itself failing — a ref it cannot resolve exits 1 exactly as a
 *    conflict does — so stdout, not the exit status, is what separates the two.
 *
 * Neither answer stops the delivery: the pull request is where the base and
 * the head meet, and GitHub reports the same conflict on it. A base that
 * merges cleanly needs no second warning, so only a conflict, or a merge that
 * could not be attempted, adds one. A conflict names at most
 * `MAX_NAMED_CONFLICT_PATHS` paths and counts the rest, so a wide conflict
 * cannot turn one warning into a line thousands of characters long.
 *
 * `base` is the ref the delivery diffed against, so on the usual path this
 * compares against the `origin/<base>` that step 4 just fetched rather than a
 * local branch that may be older.
 */
async function baseGapWarnings(
  root: string,
  base: string,
  head: string,
  timeoutMs?: number,
): Promise<string[]> {
  const ancestor = await git(
    ["merge-base", "--is-ancestor", base, head],
    root,
    timeoutMs,
  );
  if (ancestor.code === 0) return [];
  if (ancestor.code !== 1) {
    return [
      `git merge-base --is-ancestor ${base} ${head} failed, so whether ` +
        `${base} has commits that ${head} does not have is unknown: ` +
        failureMessage(ancestor),
    ];
  }

  const counted = await git(
    ["rev-list", "--count", `${head}..${base}`],
    root,
    timeoutMs,
  );
  const count = counted.code === 0 ? Number(counted.stdout.trim()) : Number.NaN;
  // A count that could not be read leaves the fact and drops the number,
  // rather than reporting a number that contradicts the answer above.
  const commits =
    Number.isInteger(count) && count > 0
      ? `${count} commit${count === 1 ? "" : "s"}`
      : "commits";
  const warnings = [
    `${base} has ${commits} not in ${head}; this delivery does not merge ` +
      `${base} into ${head}`,
  ];

  const merged = await git(
    ["merge-tree", "--write-tree", "--name-only", base, head],
    root,
    timeoutMs,
  );
  if (merged.code === 0) return warnings;
  if (!merged.stdout.trim()) {
    warnings.push(
      `git merge-tree --write-tree ${base} ${head} failed, so whether those ` +
        `commits conflict is unknown: ${failureMessage(merged)}`,
    );
    return warnings;
  }

  const paths: string[] = [];
  for (const line of merged.stdout.split("\n").slice(1)) {
    if (!line) break;
    paths.push(line);
  }
  const rest = paths.length - MAX_NAMED_CONFLICT_PATHS;
  warnings.push(
    paths.length > 0
      ? `merging ${base} into ${head} conflicts in ${paths.length} ` +
          `file${paths.length === 1 ? "" : "s"}: ` +
          paths.slice(0, MAX_NAMED_CONFLICT_PATHS).join(", ") +
          (rest > 0 ? `, and ${rest} more` : "")
      : `merging ${base} into ${head} conflicts`,
  );
  return warnings;
}

/**
 * CLI wrapper around `deliverCard`: it only formats the outcome.
 *
 * Exit codes match the other subcommands: 0 when the card was delivered or
 * there was nothing to deliver, 1 when the card is blocked or a git, `gh` or
 * board step failed, 2 for a usage error.
 */
export async function deliver(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const cardId = positional[0];
  if (!cardId) {
    process.stderr.write(
      "usage: change deliver <card-id> [--base <branch>] [--head <branch>]\n",
    );
    return 2;
  }

  const boardPath = resolveBoardPath(options.board);
  const outcome = await deliverCard({
    boardPath,
    cardId,
    base: options.base ?? null,
    head: options.head ?? null,
  });

  for (const warning of outcome.warnings) process.stderr.write(`${warning}\n`);

  process.stdout.write(`card:             ${cardId}\n`);
  process.stdout.write(`delivery:         ${outcome.status}\n`);
  if (outcome.status === "skipped" && outcome.reason) {
    process.stdout.write(`reason:           ${outcome.reason}\n`);
  }
  if (outcome.pr) {
    process.stdout.write(
      `pull request:     #${outcome.pr.number} (${outcome.pr.state})\n`,
    );
    process.stdout.write(`board updated:    ${boardPath}\n`);
  }
  for (const line of outcome.unmerged ?? []) {
    process.stderr.write(`not merged:       ${line}\n`);
  }
  if (
    (outcome.status === "blocked" || outcome.status === "failed") &&
    outcome.reason
  ) {
    process.stderr.write(`${outcome.reason}\n`);
  }
  if (outcome.pr?.url) process.stdout.write(`${outcome.pr.url}\n`);

  return outcome.status === "blocked" || outcome.status === "failed" ? 1 : 0;
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
  reviewed <change-id>
                      record the commit an independent review read, in
                      changes[].pr.reviewed_sha
  sync [<card-id>]    read the pull request state of every recorded change of
                      one card, or of the whole board with --all, and write it
                      back in a single board write
  deliver <card-id>   synchronize the card's changes, then open (or update) the
                      pull request that merges the finished card into the
                      repository default branch, and record it in the card's
                      delivery

options:
  --board <path>      board.yaml, or a project directory containing one
                      (default: $OVERLORD_BOARD, else the current directory)
  --base <branch>     branch to start from, and to merge the pull request into
                      (default for start and pr: the current branch of the main
                      checkout; for deliver: the repository default branch)
  --head <branch>     deliver only: the branch to deliver
                      (default: the current branch of the main checkout)
  --number <n>        pr only: record the pull request with this number instead
                      of creating one, for a pull request opened by hand
  --sha <sha>         reviewed only: the reviewed commit, instead of the
                      worktree HEAD or the pull request head
  --all               sync only: every card on the board instead of one card
`;

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "start") return start(argv.slice(1));
  if (command === "pr") return pr(argv.slice(1));
  if (command === "reviewed") return reviewed(argv.slice(1));
  if (command === "sync") return sync(argv.slice(1));
  if (command === "deliver") return deliver(argv.slice(1));
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
