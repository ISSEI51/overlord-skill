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
 *   change merge    <change-id> [--board <path>]
 *   change deliver  <card-id> [--board <path>] [--base <branch>] [--head <branch>]
 *   change identity
 */

import { dirname, resolve } from "node:path";

import {
  BoardLockError,
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
import {
  agentIdentity,
  describeAccount,
  ghEnvFor,
  pushAttributionWarning,
  pushCredentialArgs,
  pushCredentialEnv,
  unconfiguredHint,
} from "./github-identity.ts";
import {
  CommandError,
  run,
  runOrThrow,
  RUN_FAILED,
  type RunResult,
} from "./run.ts";

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
// git and gh
// ---------------------------------------------------------------------------

// Re-exported rather than moved out of sight: `run`, `RunResult` and the rest
// were part of this module's surface before they moved to `run.ts`, and both
// `server.ts` and the tests import them from here.
export { CommandError, run, runOrThrow, RUN_FAILED, type RunResult };

export function git(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
  env?: Record<string, string>,
): Promise<RunResult> {
  return run(["git", ...args], cwd, timeoutMs, env);
}

export function gitOrThrow(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  return runOrThrow(["git", ...args], cwd, timeoutMs);
}

/**
 * Run `gh` as the agent account.
 *
 * Every `gh` call goes through here, reads as well as writes. Splitting them —
 * the agent account for `pr create`, the user's for `pr view` — would mean
 * keeping a list of which subcommands write, and a subcommand missing from
 * that list would quietly open a pull request under the user's name, which is
 * the one failure this must not have. The cost is that the agent account needs
 * read access to every repository Overlord is used in, which it needs anyway
 * to open a pull request there.
 *
 * An account that was asked for but could not be resolved fails the call
 * instead of running under the active account. The failure is returned as a
 * `RunResult` rather than thrown, because `deliverCard` runs inside the console
 * server's request handler.
 */
export async function gh(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  const resolution = await agentIdentity();
  if (resolution.status === "failed") {
    return { code: RUN_FAILED, stdout: "", stderr: `${resolution.reason}\n` };
  }
  return run(["gh", ...args], cwd, timeoutMs, ghEnvFor(resolution));
}

export async function ghOrThrow(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<RunResult> {
  const result = await gh(args, cwd, timeoutMs);
  if (result.code !== 0) throw new CommandError(["gh", ...args], result);
  return result;
}

/**
 * The `agent account:` line the commands print before they push.
 *
 * A pull request opened under the wrong account is only visible on GitHub,
 * long after the run, so the account is named in the output of every run that
 * creates one.
 */
async function agentAccountLine(): Promise<string> {
  const resolution = await agentIdentity();
  if (resolution.status === "unconfigured") {
    return `(none configured, using the active gh account)`;
  }
  if (resolution.status === "failed") return "(could not be resolved)";
  return describeAccount(resolution.identity);
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
  /**
   * Things the caller should say but that did not stop the push — currently
   * only a remote the agent account's token cannot authenticate to.
   */
  warnings: string[];
};

/** The push URL of `origin`, or null when it cannot be read. */
async function pushRemoteUrl(
  root: string,
  timeoutMs?: number,
): Promise<string | null> {
  const url = await git(
    ["remote", "get-url", "--push", "origin"],
    root,
    timeoutMs,
  );
  if (url.code !== 0) return null;
  const value = url.stdout.trim();
  return value === "" ? null : value;
}

/**
 * How `git push` is authenticated, and what to say about it.
 *
 * With no agent account configured this adds nothing and the push uses the
 * credentials git already had, exactly as before.
 */
async function pushIdentity(
  root: string,
  timeoutMs?: number,
): Promise<
  | { ok: true; args: string[]; env?: Record<string, string>; warnings: string[] }
  | { ok: false; error: string }
> {
  const resolution = await agentIdentity();
  if (resolution.status === "failed") {
    return { ok: false, error: resolution.reason };
  }
  if (resolution.status === "unconfigured") {
    return { ok: true, args: [], warnings: [] };
  }

  const url = await pushRemoteUrl(root, timeoutMs);
  if (url === null) {
    return {
      ok: true,
      args: pushCredentialArgs(),
      env: pushCredentialEnv(resolution.identity),
      warnings: [
        "could not read the push URL of origin, so it could not be checked " +
          "that the agent account's token is sent to that host.",
      ],
    };
  }
  const warning = pushAttributionWarning(resolution.identity, url);
  if (warning) {
    // No credential is injected: a token for github.com must not be sent to a
    // host it does not belong to, and an SSH remote never asks for one.
    return { ok: true, args: [], warnings: [warning] };
  }
  return {
    ok: true,
    args: pushCredentialArgs(),
    env: pushCredentialEnv(resolution.identity),
    warnings: [],
  };
}

/**
 * Make sure `origin/<branch>` exists and carries the local commits.
 *
 * This runs in the main repository rather than in the change worktree, so it
 * works whichever checkout the command was started from. The branch is always
 * named explicitly, so the current HEAD of that checkout is never pushed by
 * accident.
 *
 * The push is the one git command that is authenticated as the agent account:
 * GitHub attributes a push to the owner of the credential that made it, and
 * everything else this module runs is either local or a read that no account
 * is recorded against.
 */
async function pushBranch(
  root: string,
  branch: string,
  timeoutMs?: number,
): Promise<PushOutcome> {
  const identity = await pushIdentity(root, timeoutMs);
  if (!identity.ok) {
    return { ok: false, lines: [], error: identity.error, warnings: [] };
  }
  const { args: auth, env, warnings } = identity;

  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
    root,
    timeoutMs,
  );
  if (upstream.code !== 0) {
    const lines = [`push:             git push -u origin ${branch}`];
    const pushed = await git(
      [...auth, "push", "-u", "origin", branch],
      root,
      timeoutMs,
      env,
    );
    if (pushed.code !== 0) {
      return { ok: false, lines, error: failureMessage(pushed), warnings };
    }
    return { ok: true, lines, error: null, warnings };
  }

  const ahead = await git(
    ["rev-list", "--count", `${upstream.stdout.trim()}..${branch}`],
    root,
    timeoutMs,
  );
  if (ahead.code === 0 && Number.parseInt(ahead.stdout.trim(), 10) > 0) {
    const lines = [`push:             git push origin ${branch}`];
    const pushed = await git(
      [...auth, "push", "origin", branch],
      root,
      timeoutMs,
      env,
    );
    if (pushed.code !== 0) {
      return { ok: false, lines, error: failureMessage(pushed), warnings };
    }
    return { ok: true, lines, error: null, warnings };
  }

  return {
    ok: true,
    lines: [`push:             origin/${branch} is up to date`],
    error: null,
    warnings,
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
  process.stdout.write(`agent account:    ${await agentAccountLine()}\n`);

  // What `gh pr view` is asked about: a number when one is already known, the
  // branch when the pull request was just created.
  let ref = String(number);

  if (number === null) {
    const pushed = await pushBranch(root, branch);
    for (const line of pushed.lines) process.stdout.write(`${line}\n`);
    for (const warning of pushed.warnings) {
      process.stderr.write(`${warning}\n`);
    }
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
  /**
   * Head branch the attempt used, on a failure that got far enough to resolve
   * one. The caller records it, so that a failure on the board names the same
   * branches a success would have.
   */
  head?: string;
  /** Base branch the attempt used, on a failure that got far enough. */
  base?: string;
  /** `<change-id>  <title>` for every change that is not merged yet. */
  unmerged?: string[];
  /** Non-fatal problems: the run continued in spite of them. */
  warnings: string[];
};

/**
 * The default branch as the local checkout records it, or null.
 *
 * `refs/remotes/origin/HEAD` is a local symbolic ref that only exists once
 * something set it (`git clone` does, `git init` does not), and nothing
 * verifies it afterwards: it can name a branch that does not exist, and any
 * process that can write to the checkout can point it anywhere.
 */
async function localDefaultBranch(
  root: string,
  timeoutMs?: number,
): Promise<string | null> {
  const symbolic = await git(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    root,
    timeoutMs,
  );
  if (symbolic.code !== 0) return null;
  // `origin/main` -> `main`: the remote name is a prefix of the short form.
  const value = symbolic.stdout.trim();
  const slash = value.indexOf("/");
  const branch = slash >= 0 ? value.slice(slash + 1) : value;
  return branch || null;
}

/** The default branch as GitHub reports it for this repository, or null. */
async function githubDefaultBranch(
  root: string,
  timeoutMs?: number,
): Promise<string | null> {
  const viewed = await gh(
    ["repo", "view", "--json", "defaultBranchRef"],
    root,
    timeoutMs,
  );
  if (viewed.code !== 0) return null;
  const parsed = parseJson<{ defaultBranchRef?: { name?: unknown } }>(
    viewed.stdout,
  );
  const name = parsed?.defaultBranchRef?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/**
 * The repository default branch, or null when neither source could name it.
 *
 * `origin/HEAD` is what the repository itself says the default branch is, so
 * it is asked first and costs no network call; GitHub is asked when the local
 * ref is not set.
 *
 * This is the order for choosing the base of a delivery, where a wrong answer
 * costs a pull request against the wrong branch and is caught by the
 * `baseRefName` check before anything is written. The merge guard asks the
 * other way round; see `authoritativeDefaultBranch`.
 *
 * Null is a real answer and not an error, because the two callers need
 * different things from it: a delivery falls back to `main` and is caught by
 * the `baseRefName` check if that guess was wrong, while `merge` refuses
 * outright — it cannot tell whether a base is the default branch it must not
 * merge into if nothing can name that branch.
 */
export async function resolveDefaultBranch(
  root: string,
  timeoutMs?: number,
): Promise<string | null> {
  return (
    (await localDefaultBranch(root, timeoutMs)) ??
    (await githubDefaultBranch(root, timeoutMs))
  );
}

/**
 * The repository default branch for a decision that must not be wrong: GitHub
 * first, the local ref only when GitHub could not answer.
 *
 * `merge` refuses a pull request whose base is the default branch, because
 * merging into it releases the work and that is the user's decision. The two
 * sources of the name are not equally trustworthy for that decision:
 * `refs/remotes/origin/HEAD` is local, unverified and writable by anything
 * with the checkout, so a wrong one would name a branch that is not the
 * default and the guard would let a release through. GitHub is where the pull
 * request itself comes from, and `baseRefName` is already read from there, so
 * both halves of the comparison come from the same place.
 *
 * The local ref stays as the fallback rather than the command refusing every
 * merge when `gh` cannot reach GitHub. What is left in that case is the
 * pre-existing behaviour, and `main` and `master` are refused by name
 * regardless of either source, so a stale local ref can only matter in a
 * repository whose default branch is neither.
 */
async function authoritativeDefaultBranch(
  root: string,
  timeoutMs?: number,
): Promise<string | null> {
  return (
    (await githubDefaultBranch(root, timeoutMs)) ??
    (await localDefaultBranch(root, timeoutMs))
  );
}

/**
 * The branch a delivery pull request merges into.
 *
 * `main` is the last resort rather than an error: a wrong base is caught by
 * the `baseRefName` check before anything is written to the board.
 */
export async function resolveDeliveryBase(
  root: string,
  timeoutMs?: number,
): Promise<string> {
  return (await resolveDefaultBranch(root, timeoutMs)) ?? "main";
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
 * A `failed` outcome carries `head` and `base` as far as the attempt resolved
 * them, and `pr` when the pull request was created but recording it was what
 * failed. `deliverCard` itself still writes nothing on a failure; the caller
 * decides whether the failure belongs on the board, which the console server
 * does and the CLI does not (the CLI operator reads the diagnostic on stderr,
 * a browser that has gone away does not).
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
 *
 * Serialized per repository: see `deliveryQueues`.
 */
export async function deliverCard(
  options: DeliverOptions,
): Promise<DeliverOutcome> {
  const key = await deliveryQueueKey(options);
  return queueDelivery(key, () => deliverOneCard(options));
}

/**
 * In-process queue of deliveries, keyed by repository.
 *
 * The counterpart of `mutateBoard`'s `writeQueues`, for the git side. The
 * console starts one delivery per card and they used to overlap, but a
 * delivery contends for things the card does not own: two cards that sit on
 * the same branch push the same ref, and the second push failed with
 * `remote: error: cannot lock ref 'refs/heads/<branch>': reference already
 * exists`. Queueing rather than dropping is the point: the second card is
 * delivered after the first one finishes instead of being lost.
 *
 * The key is the main checkout of the repository, not the board path, because
 * the contended resources - the local refs, `origin` and the pull requests -
 * belong to the repository. Two boards inside one repository therefore still
 * serialize against each other. The board path is only the fallback for a
 * target git cannot answer for, where the delivery is going to fail anyway.
 *
 * This process only. A `change deliver` run in another process is not covered;
 * git itself reports that collision, as it did before.
 */
const deliveryQueues = new Map<string, Promise<unknown>>();

async function deliveryQueueKey(options: DeliverOptions): Promise<string> {
  try {
    return await mainRepoRoot(options.cwd, options.timeoutMs);
  } catch {
    return resolve(options.boardPath);
  }
}

function queueDelivery<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = deliveryQueues.get(key);
  const started = (
    previous ? previous.then(ignore, ignore) : Promise.resolve()
  ).then(work);
  const tail = started.then(ignore, ignore);
  deliveryQueues.set(key, tail);
  void tail.then(() => {
    if (deliveryQueues.get(key) === tail) deliveryQueues.delete(key);
  });
  return started;
}

function ignore(): void {
  return undefined;
}

async function deliverOneCard(
  options: DeliverOptions,
): Promise<DeliverOutcome> {
  const { boardPath, cardId, cwd, timeoutMs } = options;
  const warnings: string[] = [];

  // The branches this attempt resolved, reported on a failure so that the
  // caller can record it against the same head and base a success would name.
  let head = options.head?.trim() || null;
  let base = options.base?.trim() || null;
  const failed = (reason: string, pr?: PullRequest): DeliverOutcome => ({
    status: "failed",
    reason,
    ...(pr ? { pr } : {}),
    ...(head ? { head } : {}),
    ...(base ? { base } : {}),
    warnings,
  });

  const loaded = await loadBoard(boardPath);
  if (!loaded.exists) {
    return failed(`board not found: ${boardPath}`);
  }
  const item = findItem(loaded.board, cardId);
  if (!item) {
    return failed(`unknown card id: ${cardId} (board: ${boardPath})`);
  }

  let root: string;
  try {
    root = await mainRepoRoot(cwd, timeoutMs);
  } catch (error) {
    return failed(
      `could not resolve the repository root: ${(error as Error).message}`,
    );
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
  if (!head) {
    const current = await git(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      root,
      timeoutMs,
    );
    if (current.code !== 0) {
      return failed(
        `could not read the current branch: ${failureMessage(current)}`,
      );
    }
    head = current.stdout.trim();
    if (!head || head === "HEAD") {
      return failed(
        `${root} has a detached HEAD, so there is no branch to deliver; ` +
          "pass --head <branch>",
      );
    }
  }

  if (!base) base = await resolveDeliveryBase(root, timeoutMs);

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
    return failed(
      `git diff ${diffBase} ${head} failed: ${failureMessage(diff)}`,
    );
  }

  // 6. Report what the base holds that the head does not. This never changes
  //    the outcome: the pull request is where the two branches meet.
  warnings.push(...(await baseGapWarnings(root, diffBase, head, timeoutMs)));

  const push = await pushBranch(root, head, timeoutMs);
  warnings.push(...push.warnings);
  if (!push.ok) {
    return failed(push.error || `git push origin ${head} failed`);
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
    return failed(
      `gh pr list --head ${head} failed: ${failureMessage(listed)}`,
    );
  }
  const open = parseJson<{ number: number }[]>(listed.stdout.trim() || "[]");
  if (!open || !Array.isArray(open)) {
    return failed(`could not read: gh pr list --head ${head} --base ${base}`);
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
      return failed(`gh pr edit ${number} failed: ${failureMessage(edited)}`);
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
      return failed(`gh pr create failed: ${failureMessage(created)}`);
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
    return failed(`gh pr view ${ref} failed: ${failureMessage(viewed)}`);
  }
  const view = parseJson<DeliveryView>(viewed.stdout);
  if (!view || typeof view.number !== "number") {
    return failed(`could not read: gh pr view ${ref}`);
  }
  if (view.headRefName !== head || view.baseRefName !== base) {
    return failed(
      `pull request #${view.number} is ` +
        `"${view.headRefName ?? "(unknown)"}" -> ` +
        `"${view.baseRefName ?? "(unknown)"}", not "${head}" -> "${base}". ` +
        `Nothing was written to ${boardPath}.`,
    );
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
  try {
    await writeDelivery(boardPath, cardId, delivery);
  } catch (error) {
    // The pull request exists on GitHub; only the record of it is missing.
    // Saying "failed" without saying that would send the reader looking for a
    // pull request that is already there.
    return failed(
      `pull request #${pullRequest.number} was ${status} ` +
        `(${pullRequest.url ?? "no url"}), but recording it in ${boardPath} ` +
        `failed: ${(error as Error).message}`,
      pullRequest,
    );
  }

  return { status, pr: pullRequest, warnings };
}

/** Board writes of one delivery record, including the retries. */
const DELIVERY_WRITE_ATTEMPTS = 3;

/**
 * Record a delivery on the card, retrying while the board is locked.
 *
 * `mutateBoard` already waits `boardLock.acquireTimeoutMs` for the lock and
 * then gives up with a `BoardLockError`. That is the right answer for a
 * request a person is waiting on, and the wrong one here: the pull request has
 * already been created, so losing the record leaves GitHub and the board
 * disagreeing about work that was really done. Every other failure is raised
 * on the first attempt, because retrying it would only repeat it.
 */
async function writeDelivery(
  boardPath: string,
  cardId: string,
  delivery: Delivery,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await updateItem(boardPath, cardId, (target) => {
        target.delivery = delivery;
      });
      return;
    } catch (error) {
      if (
        !(error instanceof BoardLockError) ||
        attempt >= DELIVERY_WRITE_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
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
  // The delivery pull request is opened by whichever account `gh` ran as, and
  // that is only visible on GitHub afterwards, so the run names it — the same
  // line `pr` and `identity` print.
  process.stdout.write(`agent account:    ${await agentAccountLine()}\n`);
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
// merge
// ---------------------------------------------------------------------------

/**
 * Branches a change pull request is never merged into by this command.
 *
 * `change merge` merges one change into the branch the card's work is being
 * built on, which is another branch inside the repository. Merging into the
 * default branch is a different act: it releases the card, it is what the
 * card-level pull request `deliver` opens, and it stays the user's decision.
 * The two are told apart by the base branch alone, so the base is what is
 * guarded here.
 *
 * `main` and `master` are refused by name as well as through the repository
 * default branch, so a repository that renamed its default branch cannot be
 * released through the name it no longer uses either. The comparison ignores
 * case, because a base that differs from `main` only in case is a typo far
 * more often than it is a second branch.
 */
const PROTECTED_BASES = ["main", "master"];

/** `gh pr view` fields the merge checks are made on. */
export type MergeView = PullRequestView & {
  baseRefName: string;
  /** Every check GitHub reports for the pull request head; shape below. */
  statusCheckRollup?: unknown;
};

const MERGE_VIEW_FIELDS =
  "number,url,state,headRefOid,headRefName,baseRefName,statusCheckRollup";

/** How many failing checks the refusal names before it counts the rest. */
const MAX_NAMED_CHECKS = 5;

/** What one entry of `statusCheckRollup` says about one check. */
export type CheckOutcome = "passed" | "neutral" | "pending" | "failed";

/**
 * The state of the checks on a pull request head.
 *
 * `passed` counts only the checks that concluded successfully, so it is not
 * `total` minus the failures: a check that was skipped or that reported a
 * neutral conclusion is counted in `total` and in neither of the two.
 */
export type CiState = {
  /** Every check GitHub reported. */
  total: number;
  /** Checks that concluded successfully. */
  passed: number;
  /** Why the pull request must not be merged, or null when the CI is green. */
  reason: string | null;
};

/**
 * The entries of `statusCheckRollup`, whichever shape `gh` returned.
 *
 * `gh pr view --json statusCheckRollup` returns a flat array; the same field
 * read through the GraphQL connection is an object with a `nodes` array. Both
 * are accepted so that the gate does not depend on which one the installed
 * `gh` produces. Anything else - null for a pull request with no checks at
 * all, or a shape neither of these - yields no entries, which the gate refuses
 * as "no check has run" rather than passes.
 */
function rollupEntries(rollup: unknown): unknown[] {
  if (Array.isArray(rollup)) return rollup;
  if (rollup && typeof rollup === "object") {
    const nodes = (rollup as { nodes?: unknown }).nodes;
    if (Array.isArray(nodes)) return nodes;
  }
  return [];
}

/** The name to report a check by: a check run's, or a status context's. */
function checkName(entry: Record<string, unknown>): string {
  const name = entry.name ?? entry.context;
  return typeof name === "string" && name.trim() ? name.trim() : "(unnamed)";
}

/**
 * Read one rollup entry as one of four outcomes.
 *
 * The two entry types are read the way GitHub defines them:
 *
 *   - a `CheckRun` finishes when `status` is `COMPLETED`, and only then does
 *     `conclusion` mean anything. `SUCCESS` passed; `SKIPPED` and `NEUTRAL`
 *     neither passed nor failed, which is what a job that a workflow condition
 *     turned off looks like; every other conclusion - `FAILURE`, `TIMED_OUT`,
 *     `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE` - failed;
 *   - a `StatusContext` carries `state` instead, with `PENDING` and `EXPECTED`
 *     unfinished and `SUCCESS` the only passing value.
 *
 * An entry that says neither is read as `pending`: an unfinished check and an
 * unreadable one both mean the CI has not been shown to be green, and this
 * command refuses in both cases.
 */
export function checkOutcome(entry: unknown): CheckOutcome {
  if (!entry || typeof entry !== "object") return "pending";
  const node = entry as Record<string, unknown>;

  const status = typeof node.status === "string" ? node.status.toUpperCase() : null;
  if (status !== null && status !== "COMPLETED") return "pending";

  const conclusion =
    typeof node.conclusion === "string" ? node.conclusion.toUpperCase() : null;
  if (conclusion !== null) {
    if (conclusion === "SUCCESS") return "passed";
    if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") return "neutral";
    return "failed";
  }

  const state = typeof node.state === "string" ? node.state.toUpperCase() : null;
  if (state !== null) {
    if (state === "SUCCESS") return "passed";
    if (state === "PENDING" || state === "EXPECTED") return "pending";
    return "failed";
  }

  return "pending";
}

/**
 * Decide whether the CI on a pull request head allows a merge.
 *
 * Kept pure so the gate can be fixed by tests without reaching GitHub, and so
 * the same reading is reported to the operator and used for the decision.
 *
 * A pull request with no check at all is refused rather than passed. "No check
 * ran" and "every check passed" are indistinguishable to a rule that only
 * looks for failures, and the first one is exactly what a pull request opened
 * before the repository had CI looks like - pull request #24 of this
 * repository was merged in that state. Treating it as unverified is the point
 * of the gate.
 *
 * A run where every check was skipped is refused for the same reason: nothing
 * was verified, so `passed` has to be at least one.
 */
export function checkRollup(rollup: unknown): CiState {
  const entries = rollupEntries(rollup);
  const failed: string[] = [];
  const pending: string[] = [];
  let passed = 0;

  for (const entry of entries) {
    const outcome = checkOutcome(entry);
    const name = checkName((entry ?? {}) as Record<string, unknown>);
    if (outcome === "passed") passed += 1;
    else if (outcome === "failed") failed.push(name);
    else if (outcome === "pending") pending.push(name);
  }

  const total = entries.length;
  const state: CiState = { total, passed, reason: null };

  if (total === 0) {
    state.reason =
      "no check has run on this pull request, so its CI has not been shown " +
      "to pass; a pull request without CI is not merged by this command";
    return state;
  }
  if (failed.length > 0) {
    state.reason = `${failed.length} of ${total} checks did not pass: ${nameList(failed)}`;
    return state;
  }
  if (pending.length > 0) {
    state.reason = `${pending.length} of ${total} checks have not finished: ${nameList(pending)}`;
    return state;
  }
  if (passed === 0) {
    state.reason =
      `none of the ${total} checks concluded successfully (every one was ` +
      "skipped or neutral), so the CI has not been shown to pass";
    return state;
  }
  return state;
}

/** At most `MAX_NAMED_CHECKS` names, with the rest counted. */
function nameList(names: string[]): string {
  const rest = names.length - MAX_NAMED_CHECKS;
  const head = names.slice(0, MAX_NAMED_CHECKS).join(", ");
  return rest > 0 ? `${head}, and ${rest} more` : head;
}

/** One line describing what the checks said, for the command's output. */
export function checkSummary(checks: CiState): string {
  if (checks.total === 0) return "none have run";
  return `${checks.passed} of ${checks.total} passed`;
}

/** What `mergeRefusal` is asked about. */
export type MergeCandidate = {
  changeId: string;
  /** `changes[].branch`, the branch the board records for this change. */
  branch: string | null | undefined;
  /** `changes[].pr.reviewed_sha`, as the board records it. */
  reviewedSha: string | null | undefined;
  /** The pull request as GitHub reports it now. */
  view: MergeView;
  /** The repository default branch, or null when it could not be named. */
  defaultBranch: string | null;
  /** The reading of `view.statusCheckRollup`. */
  checks: CiState;
};

/**
 * Why this pull request must not be merged, or null when every gate passed.
 *
 * The whole merge decision, as one pure function, so that every gate can be
 * fixed by a test without reaching GitHub and so that no caller can merge
 * while skipping one. There is deliberately no argument and no environment
 * variable that relaxes any of them: a merge this refuses is a merge a person
 * performs.
 *
 * The gates, in the order they are reported:
 *
 *  1. the base branch. Checked first because it separates the two kinds of
 *     pull request - a change pull request between branches of the repository,
 *     and the card-level delivery pull request that releases work to the
 *     default branch - and only the first kind is this command's to merge;
 *  2. the head branch is the one the board records for the change, the same
 *     check `pr --number` and `sync` make. Without it a wrong `pr.number`
 *     merges somebody else's pull request;
 *  3. the pull request is open. A merged or closed one has nothing to merge;
 *  4. the review. `reviewed_sha` is written by the independent reviewer, so a
 *     change without one has not been reviewed at all, and one that does not
 *     name the pull request head carries commits no review has read;
 *  5. the CI, as `checkRollup` read it.
 */
export function mergeRefusal(candidate: MergeCandidate): string | null {
  const { changeId, branch, reviewedSha, view, defaultBranch, checks } = candidate;
  const number = view.number;
  const base = typeof view.baseRefName === "string" ? view.baseRefName.trim() : "";
  const head = typeof view.headRefName === "string" ? view.headRefName : "";

  // 1. base branch.
  if (!base) {
    return (
      `pull request #${number} does not name a base branch, so whether it ` +
      "merges into the repository default branch cannot be decided"
    );
  }
  if (PROTECTED_BASES.includes(base.toLowerCase())) {
    return (
      `pull request #${number} merges into "${base}". A pull request whose ` +
      "base is main or master releases the work, and that merge is the " +
      "user's to perform; this command only merges a change into the branch " +
      "the card is built on"
    );
  }
  if (defaultBranch === null) {
    return (
      "the repository default branch could not be determined, so whether " +
      `pull request #${number} merges into it cannot be decided`
    );
  }
  if (base.toLowerCase() === defaultBranch.trim().toLowerCase()) {
    return (
      `pull request #${number} merges into "${base}", the repository default ` +
      "branch. Merging into the default branch releases the work and is the " +
      "user's to perform"
    );
  }

  // 2. head branch.
  if (!branch) {
    return (
      `change ${changeId} has no branch on the board, so pull request ` +
      `#${number} cannot be checked against it`
    );
  }
  if (head !== branch) {
    return (
      `pull request #${number} is on branch "${head || "(unknown)"}", not ` +
      `the branch recorded for ${changeId} ("${branch}")`
    );
  }

  // 3. pull request state.
  const state = normalizePrState(view.state);
  if (state !== "open") {
    return (
      `pull request #${number} is ${state ?? "in an unknown state"}, not ` +
      "open, so there is nothing to merge"
    );
  }

  // 4. review.
  const headSha = typeof view.headRefOid === "string" ? view.headRefOid : "";
  if (!headSha) {
    return `the head commit of pull request #${number} could not be read`;
  }
  if (!reviewedSha) {
    return (
      `change ${changeId} has no reviewed_sha on the board, so no independent ` +
      `review has been recorded for it; run "change reviewed ${changeId}" ` +
      "after the review concludes"
    );
  }
  if (!sameCommit(headSha, reviewedSha)) {
    return (
      `commits were added after the review of ${changeId} (reviewed ` +
      `${reviewedSha}, head ${headSha}); review the new commits and record ` +
      `them with "change reviewed ${changeId}"`
    );
  }

  // 5. CI.
  if (checks.reason) {
    return `pull request #${number}: ${checks.reason}`;
  }

  return null;
}

export type MergeOptions = {
  boardPath: string;
  changeId: string;
  /** Directory to resolve the repository from; the process cwd by default. */
  cwd?: string;
  /** Per-command timeout for every git and `gh` call. */
  timeoutMs?: number;
};

/** The pull request as the gates saw it, for the command's output. */
export type MergeCheckedPullRequest = {
  number: number;
  state: string | null;
  head: string;
  base: string;
  reviewedSha: string | null;
  checks: CiState;
};

export type MergeOutcome = {
  /**
   * `refused` is a gate saying no: nothing was merged and nothing was written.
   * `failed` is a git, `gh` or board step that did not complete.
   */
  status: "merged" | "refused" | "failed";
  /** Why the run ended this way; absent on a plain success. */
  reason?: string;
  /** What the gates were given, when the run got as far as reading them. */
  checked?: MergeCheckedPullRequest;
  /** The pull request record written to the board, on a merge. */
  pr?: PullRequest;
  /** The change state after the board write. */
  changeState?: State;
  /** Non-fatal problems: the run continued in spite of them. */
  warnings: string[];
};

/**
 * Merge one change pull request into its own base branch and record it.
 *
 * Writes nothing to stdout or stderr: everything it did is in the returned
 * `MergeOutcome`, the same way `deliverCard` reports itself, so the CLI
 * wrapper owns the output.
 *
 * The order of the steps is the point of the command:
 *
 *  1. the pull request is read from GitHub, never from the board, so every
 *     gate is decided on what is true now;
 *  2. `mergeRefusal` decides. A refusal returns before `gh pr merge` is
 *     called, so a refused run leaves GitHub and `board.yaml` both untouched;
 *  3. the merge is a merge commit (`--merge`). Squash and rebase are not used
 *     and cannot be selected: a squash does not advance the merge base, which
 *     made later pull requests conflict on the same lines (README, "なぜ merge
 *     commit なのか"). It also carries `--match-head-commit`, so GitHub merges
 *     only while the head is the commit the gates were decided on and a commit
 *     pushed after step 1 cannot be merged unreviewed;
 *  4. the board is written from a second `gh pr view`, through
 *     `applyPullRequestView` - the function `sync` writes with - so a merge
 *     records exactly what a later `sync` would have recorded, and `done` has
 *     one writer rather than two.
 */
export async function mergeChange(
  options: MergeOptions,
): Promise<MergeOutcome> {
  const { boardPath, changeId, cwd, timeoutMs } = options;
  const warnings: string[] = [];

  const loaded = await loadBoard(boardPath);
  if (!loaded.exists) {
    return { status: "failed", reason: `board not found: ${boardPath}`, warnings };
  }
  const found = findChange(loaded.board, changeId);
  if (!found) {
    return {
      status: "failed",
      reason: `unknown change id: ${changeId} (board: ${boardPath})`,
      warnings,
    };
  }

  const number = found.change.pr?.number;
  if (typeof number !== "number") {
    return {
      status: "failed",
      reason:
        `change ${changeId} has no pull request on the board; ` +
        `run "change pr ${changeId}" first.`,
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

  const viewed = await gh(
    ["pr", "view", String(number), "--json", MERGE_VIEW_FIELDS],
    root,
    timeoutMs,
  );
  if (viewed.code !== 0) {
    return {
      status: "failed",
      reason: `gh pr view ${number} failed: ${failureMessage(viewed)}`,
      warnings,
    };
  }
  const view = parseJson<MergeView>(viewed.stdout);
  if (!view || typeof view.number !== "number") {
    return {
      status: "failed",
      reason: `could not read: gh pr view ${number}`,
      warnings,
    };
  }

  // GitHub is the authority here, not the local `origin/HEAD`; see
  // `authoritativeDefaultBranch`.
  const defaultBranch = await authoritativeDefaultBranch(root, timeoutMs);
  const checks = checkRollup(view.statusCheckRollup);
  // The head every gate below is decided on, and the head the merge is made
  // conditional on. `mergeRefusal` refuses an empty one, so by the time it is
  // used it names a commit.
  const headSha = typeof view.headRefOid === "string" ? view.headRefOid.trim() : "";
  const checked: MergeCheckedPullRequest = {
    number: view.number,
    state: normalizePrState(view.state),
    head: typeof view.headRefName === "string" ? view.headRefName : "",
    base: typeof view.baseRefName === "string" ? view.baseRefName : "",
    reviewedSha: found.change.pr?.reviewed_sha ?? null,
    checks,
  };

  const refusal = mergeRefusal({
    changeId,
    branch: found.change.branch,
    reviewedSha: found.change.pr?.reviewed_sha,
    view,
    defaultBranch,
    checks,
  });
  if (refusal) {
    return {
      status: "refused",
      reason:
        `${refusal}.\nNothing was merged and nothing was written to ${boardPath}.`,
      checked,
      warnings,
    };
  }

  // `--match-head-commit` is the same commit every gate above was decided on:
  // GitHub performs the merge only while the pull request head is still that
  // commit. Without it there is a window between the `gh pr view` the gates
  // read and this call in which a commit can be pushed to the branch, and that
  // commit would be merged although no review has read it — the one outcome
  // the review gate exists to prevent.
  const merged = await gh(
    ["pr", "merge", String(view.number), "--merge", "--match-head-commit", headSha],
    root,
    timeoutMs,
  );
  if (merged.code !== 0) {
    return {
      status: "failed",
      reason:
        `gh pr merge ${view.number} --merge failed: ${failureMessage(merged)}` +
        `\nThe merge was asked for only while the head was ${headSha}, the ` +
        `commit the checks above were made on, so a commit pushed since then ` +
        `is one reason gh can refuse it.`,
      checked,
      warnings,
    };
  }

  // Read back rather than assume: the board records the pull request GitHub
  // reports after the merge, which is also what a later `sync` would record.
  const after = await gh(
    ["pr", "view", String(view.number), "--json", PR_VIEW_FIELDS],
    root,
    timeoutMs,
  );
  const unrecorded = (detail: string): MergeOutcome => ({
    status: "failed",
    reason:
      `pull request #${view.number} was merged, but ${detail}, so ` +
      `${boardPath} still shows the change as it was. Run ` +
      `"change sync ${found.item.id}" to record it.`,
    checked,
    warnings,
  });
  if (after.code !== 0) {
    return unrecorded(`gh pr view ${view.number} failed: ${failureMessage(after)}`);
  }
  const afterView = parseJson<PullRequestView>(after.stdout);
  if (!afterView || typeof afterView.number !== "number") {
    return unrecorded(`gh pr view ${view.number} could not be read`);
  }
  if (afterView.headRefName !== found.change.branch) {
    return unrecorded(
      `it is now reported on branch "${afterView.headRefName ?? "(unknown)"}" ` +
        `rather than "${found.change.branch}"`,
    );
  }

  let written: Change;
  try {
    written = await updateChange(boardPath, changeId, (change) => {
      applyPullRequestView(change, afterView);
    });
  } catch (error) {
    return unrecorded(`writing the board failed: ${(error as Error).message}`);
  }

  const pullRequest = written.pr ?? undefined;
  if (written.state !== "done") {
    return {
      status: "failed",
      reason:
        `pull request #${view.number} was merged, but GitHub still reports ` +
        `it as ${normalizePrState(afterView.state) ?? "unknown"}, so ` +
        `${changeId} was not moved to done. Run ` +
        `"change sync ${found.item.id}" once GitHub reports the merge.`,
      checked,
      ...(pullRequest ? { pr: pullRequest } : {}),
      changeState: written.state,
      warnings,
    };
  }

  return {
    status: "merged",
    checked,
    ...(pullRequest ? { pr: pullRequest } : {}),
    changeState: written.state,
    warnings,
  };
}

/** The one usage line `change merge` prints for every argument error. */
const MERGE_USAGE = "usage: change merge <change-id> [--board <path>]\n";

/**
 * CLI wrapper around `mergeChange`: it only formats the outcome.
 *
 * `--board` is the only option it takes. Every other option is a usage error
 * rather than an ignored argument, so that a `--force`, a `--base` or an
 * `--admin` copied from `gh` fails loudly instead of looking as though it
 * relaxed a gate that it did not. A second positional argument is a usage
 * error for the same reason: `change merge OV-1-C1 OV-1-C2` would otherwise
 * merge the first of the two and say nothing about the second.
 *
 * Every argument error exits 2, including an option left without a value.
 * `parseArgs` throws for that one, and an uncaught throw leaves `main` to exit
 * 1, which is the code a refused merge uses — so `change merge OV-1-C1
 * --admin` would have been indistinguishable from a gate saying no.
 */
export async function merge(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${MERGE_USAGE}`);
    return 2;
  }
  const { positional, options } = parsed;
  const changeId = positional[0];
  if (!changeId) {
    process.stderr.write(MERGE_USAGE);
    return 2;
  }

  const unknown = Object.keys(options).filter((name) => name !== "board");
  if (unknown.length > 0) {
    process.stderr.write(
      `change merge takes no option other than --board: ` +
        `${unknown.map((name) => `--${name}`).join(", ")}\n` +
        "The base, review and CI checks cannot be turned off.\n",
    );
    return 2;
  }

  if (positional.length > 1) {
    process.stderr.write(
      `change merge takes one change id, and was given ${positional.length}: ` +
        `${positional.join(", ")}\n` +
        "Nothing was merged. Run it once per change.\n" +
        MERGE_USAGE,
    );
    return 2;
  }

  const boardPath = resolveBoardPath(options.board);
  const outcome = await mergeChange({ boardPath, changeId });

  process.stdout.write(`change:           ${changeId}\n`);
  const checked = outcome.checked;
  if (checked) {
    process.stdout.write(
      `pull request:     #${checked.number} (${checked.state ?? "unknown"})\n`,
    );
    process.stdout.write(`head branch:      ${checked.head || "(unknown)"}\n`);
    process.stdout.write(`base branch:      ${checked.base || "(unknown)"}\n`);
    process.stdout.write(
      `reviewed commit:  ${checked.reviewedSha ?? "(not recorded)"}\n`,
    );
    process.stdout.write(`checks:           ${checkSummary(checked.checks)}\n`);
  }
  if (outcome.status === "merged") {
    process.stdout.write(
      `merged:           #${outcome.pr?.number ?? checked?.number} with a merge commit\n`,
    );
    process.stdout.write(`change state:     ${outcome.changeState}\n`);
    process.stdout.write(`board updated:    ${boardPath}\n`);
  }

  for (const warning of outcome.warnings) process.stderr.write(`${warning}\n`);
  if (outcome.reason) process.stderr.write(`${outcome.reason}\n`);

  if (outcome.status !== "merged") return 1;
  if (outcome.pr?.url) process.stdout.write(`${outcome.pr.url}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** Repository permissions that allow a branch to be pushed. */
const WRITE_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

/** The `gh repo view` fields `identity` reads. */
const REPO_VIEW_FIELDS = "nameWithOwner,viewerPermission";

/**
 * Report the account Overlord acts as here, and check that it can do the two
 * things it exists for: open a pull request, and push a branch.
 *
 * This is a preflight for a project Overlord has not been used in yet. The
 * account is configured once for every project, but access is granted per
 * repository, so the answer to "will pull requests here be opened by the bot?"
 * is different in every checkout and is otherwise only discovered by opening
 * one under the wrong name.
 *
 * Exit 0 when a configured account was verified, 1 otherwise — including when
 * no account is configured at all, because the question the command answers is
 * "does this repository produce agent-owned pull requests?", and then it does
 * not.
 */
export async function identity(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  if (positional.length > 0 || Object.keys(options).length > 0) {
    process.stderr.write(
      "usage: change identity\n" +
        "change identity takes no argument: it reports the account this " +
        "checkout acts as.\n",
    );
    return 2;
  }

  const resolution = await agentIdentity();
  if (resolution.status === "unconfigured") {
    process.stdout.write(`agent account:    (none configured)\n`);
    for (const line of unconfiguredHint()) process.stderr.write(`${line}\n`);
    return 1;
  }
  if (resolution.status === "failed") {
    process.stdout.write(`agent account:    (could not be resolved)\n`);
    process.stderr.write(`${resolution.reason}\n`);
    return 1;
  }

  const { identity: account } = resolution;
  process.stdout.write(`agent account:    ${describeAccount(account)}\n`);
  process.stdout.write(`token source:     ${account.source}\n`);

  let root: string;
  try {
    root = await mainRepoRoot();
  } catch (error) {
    process.stderr.write(
      `not inside a git repository: ${(error as Error).message}\n`,
    );
    return 1;
  }

  // 1. The token has to belong to the account that was asked for. A token
  //    read from `$OVERLORD_GH_TOKEN` is whatever the user pasted, and a
  //    keyring entry can be renamed; either way, acting as the wrong account
  //    would be invisible until a pull request appeared under it.
  const viewer = await gh(["api", "user", "--jq", ".login"], root);
  if (viewer.code !== 0) {
    process.stderr.write(
      `the agent account's token was rejected by GitHub: ` +
        `${failureMessage(viewer)}\n`,
    );
    return 1;
  }
  const login = viewer.stdout.trim();
  process.stdout.write(`github login:     ${login || "(unknown)"}\n`);
  if (
    account.account !== null &&
    login.toLowerCase() !== account.account.toLowerCase()
  ) {
    process.stderr.write(
      `the token resolved for "${account.account}" authenticates as ` +
        `"${login}". Pull requests would be opened by "${login}".\n`,
    );
    return 1;
  }

  // 2. Write access on this repository, which is granted per repository and is
  //    what a push and a pull request both need.
  const repo = await gh(["repo", "view", "--json", REPO_VIEW_FIELDS], root);
  if (repo.code !== 0) {
    process.stderr.write(
      `${login} cannot read this repository: ${failureMessage(repo)}\n` +
        `Add ${login} as a collaborator with write access.\n`,
    );
    return 1;
  }
  const view = parseJson<{
    nameWithOwner?: unknown;
    viewerPermission?: unknown;
  }>(repo.stdout);
  if (!view) {
    process.stderr.write(
      `could not read: gh repo view --json ${REPO_VIEW_FIELDS}\n`,
    );
    return 1;
  }
  const nameWithOwner =
    typeof view.nameWithOwner === "string" ? view.nameWithOwner : "(unknown)";
  const permission =
    typeof view.viewerPermission === "string"
      ? view.viewerPermission
      : "(unknown)";
  process.stdout.write(`repository:       ${nameWithOwner}\n`);
  process.stdout.write(`permission:       ${permission}\n`);
  if (!WRITE_PERMISSIONS.has(permission)) {
    process.stderr.write(
      `${login} has "${permission}" on ${nameWithOwner}, which cannot push a ` +
        `branch or open a pull request. Add ${login} as a collaborator with ` +
        `write access.\n`,
    );
    return 1;
  }

  // 3. The push is authenticated by a credential helper, which only HTTPS
  //    remotes ask for.
  const url = await pushRemoteUrl(root);
  process.stdout.write(`push remote:      ${url ?? "(none)"}\n`);
  if (url === null) {
    process.stderr.write(
      `origin has no push URL, so no branch can be pushed from here.\n`,
    );
    return 1;
  }
  const warning = pushAttributionWarning(account, url);
  if (warning) {
    process.stdout.write(`push identity:    (not the agent account)\n`);
    process.stderr.write(`${warning}\n`);
    return 1;
  }
  process.stdout.write(`push identity:    ${login}\n`);
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
  reviewed <change-id>
                      record the commit an independent review read, in
                      changes[].pr.reviewed_sha
  sync [<card-id>]    read the pull request state of every recorded change of
                      one card, or of the whole board with --all, and write it
                      back in a single board write
  merge <change-id>   merge the change pull request into its own base branch
                      with a merge commit, after checking that the base is not
                      main, master or the repository default branch, that the
                      pull request is the change's own and still open, that its
                      head is the reviewed commit, and that its CI passed, then
                      record the merge on the board. There is no option and no
                      environment variable that skips any of those checks: a
                      merge this refuses is a merge the user performs
  deliver <card-id>   synchronize the card's changes, then open (or update) the
                      pull request that merges the finished card into the
                      repository default branch, and record it in the card's
                      delivery
  identity            report the GitHub account this checkout pushes and opens
                      pull requests as, and check that it can do both here

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

merge takes only <change-id> and --board; any other option is a usage error.
identity takes no argument at all.

environment:
  $OVERLORD_GH_ACCOUNT
                      gh account to push and open pull requests as, instead of
                      the active one. The active gh account is not switched;
                      the token is read with "gh auth token --user <account>"
                      and handed to each command through its environment
  $OVERLORD_GH_TOKEN
                      that account's token directly, for a machine where it is
                      not in the gh keyring
`;

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "start") return start(argv.slice(1));
  if (command === "pr") return pr(argv.slice(1));
  if (command === "reviewed") return reviewed(argv.slice(1));
  if (command === "sync") return sync(argv.slice(1));
  if (command === "merge") return merge(argv.slice(1));
  if (command === "deliver") return deliver(argv.slice(1));
  if (command === "identity") return identity(argv.slice(1));
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
