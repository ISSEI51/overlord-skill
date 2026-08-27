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
 */

import { resolve } from "node:path";

import {
  boardPathFor,
  canonicalItem,
  loadBoard,
  revisionOf,
  saveBoard,
  type Board,
  type Change,
  type Item,
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
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: change <command> [options]

commands:
  start <change-id>   create the worktree and branch for a change and record
                      them on the board

options:
  --board <path>      board.yaml, or a project directory containing one
                      (default: $OVERLORD_BOARD, else the current directory)
  --base <branch>     branch to start from (default: the current branch)
`;

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "start") return start(argv.slice(1));
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
