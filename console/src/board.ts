/**
 * board.yaml access.
 *
 * `docs/product-ops/board.yaml` stays the single machine-readable source of
 * truth. The console reads it, writes it back in block YAML, and detects
 * concurrent writes by an agent through a revision token.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export const STATES = [
  "inbox",
  "discovery",
  "specified",
  "implementing",
  "reviewing",
  "acceptance",
  "done",
  "blocked",
] as const;

export type State = (typeof STATES)[number];

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type Item = {
  id: string;
  project?: string | null;
  title: string;
  state: State;
  priority?: {
    impact?: number | null;
    urgency?: number | null;
    confidence?: number | null;
    ease?: number | null;
    override?: string | null;
  } | null;
  evidence?: string | null;
  acceptance_conditions?: string[] | null;
  out_of_scope?: string | null;
  owner?: string | null;
  next_action?: string | null;
  blocker?: string | null;
  updated_at?: string | null;
  /** Kept for compatibility; new work records the session on the change. */
  agent?: SessionLink | null;
  /** Engineering split of this card, in dependency order. */
  changes?: Change[] | null;
  /** Last attempt to deliver the finished card to the default branch. */
  delivery?: Delivery | null;
  [key: string]: Json | undefined;
};

/** Pointer to a running cmux session. */
export type SessionLink = {
  workspace_id?: string | null;
  surface_id?: string | null;
  cwd?: string | null;
};

/**
 * The pull request for one change. Every field stays null until the PR
 * exists, so the shape does not change when the PR lifecycle lands.
 */
export type PullRequest = {
  number?: number | null;
  url?: string | null;
  /** open | merged | closed */
  state?: string | null;
  head_sha?: string | null;
  reviewed_sha?: string | null;
};

/**
 * One engineering delivery unit under a card:
 * 1 change = 1 worktree = 1 branch = 1 pull request = 1 agent execution unit.
 *
 * Changes exist so that a single product outcome can ship as several
 * reviewable pieces without adding cards to the board. Their state uses the
 * card vocabulary minus `inbox` / `discovery` / `acceptance`: acceptance is a
 * human decision and belongs to the card alone.
 */
export type Change = {
  id: string;
  title: string;
  state: State;
  agent?: SessionLink | null;
  branch?: string | null;
  pr?: PullRequest | null;
  [key: string]: Json | undefined;
};

/**
 * The card-level pull request that delivers a finished card.
 *
 * A card is delivered once every one of its changes is merged: the branch the
 * card's work sits on (`branch`) is proposed against the repository default
 * branch (`base`). One card is one delivery record, rewritten on every
 * attempt, so the board says what the last attempt did rather than keeping a
 * history.
 *
 * `pr` is the delivery pull request, in the same shape as a change's; its
 * `reviewed_sha` stays null, because the review happened on the changes.
 * `error` is null when the last attempt recorded a pull request, and carries
 * the diagnostic when it failed. The two writers differ: `change deliver`
 * writes this record only after `gh pr view` confirmed the pull request, so a
 * failure from the command line leaves board.yaml untouched, while the console
 * server records one (`recordDeliveryFailure`) — the event stream alone left a
 * card in `done` with no pull request and nothing anywhere saying why.
 */
export type Delivery = {
  /** Head branch the delivery pull request was opened from. */
  branch?: string | null;
  /** Branch the delivery pull request merges into. */
  base?: string | null;
  pr?: PullRequest | null;
  error?: string | null;
  attempted_at?: string | null;
};

export type Board = {
  version: number;
  updated_at?: string | null;
  /** The single commander session the user talks to in Overlord Console. */
  commander?: SessionLink | null;
  decisions_required?: Json[] | null;
  items: Item[];
  [key: string]: Json | undefined;
};

const ITEM_KEY_ORDER = [
  "id",
  "project",
  "title",
  "state",
  "priority",
  "evidence",
  "acceptance_conditions",
  "out_of_scope",
  "owner",
  "next_action",
  "blocker",
  "agent",
  "changes",
  "delivery",
  "updated_at",
];

const CHANGE_KEY_ORDER = ["id", "title", "state", "agent", "branch", "pr"];

const PR_KEY_ORDER = ["number", "url", "state", "head_sha", "reviewed_sha"];

const DELIVERY_KEY_ORDER = ["branch", "base", "pr", "error", "attempted_at"];

const BOARD_KEY_ORDER = [
  "version",
  "updated_at",
  "commander",
  "decisions_required",
  "items",
];

export const EMPTY_BOARD: Board = { version: 1, updated_at: null, items: [] };

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function boardPathFor(target: string): string {
  const absolute = resolve(target);
  return absolute.endsWith(".yaml") || absolute.endsWith(".yml")
    ? absolute
    : resolve(absolute, "docs/product-ops/board.yaml");
}

/**
 * Project root for a resolved board path.
 *
 * Inverse of the `docs/product-ops/board.yaml` suffix that boardPathFor
 * appends to a directory target: when the board file sits in a
 * `<root>/docs/product-ops` directory, the root is two levels above it.
 * For a board file anywhere else, the board's own directory is the project
 * root; it is never assumed to be two levels up (which made projectRoot "/"
 * for boards near the filesystem root).
 */
export function projectRootFor(boardPath: string): string {
  const directory = dirname(boardPath);
  const suffix = `${sep}docs${sep}product-ops`;
  return directory.endsWith(suffix) ? resolve(directory, "../..") : directory;
}

/**
 * Revision token used for optimistic concurrency against agent writes.
 *
 * The token is `<mtime in nanoseconds>:<size in bytes>`. Millisecond
 * resolution was too coarse: two writes of the same byte length inside one
 * millisecond produced the same token, so a conflicting write was neither
 * rejected with 409 nor announced over SSE. `stat(path, { bigint: true })`
 * reports `mtimeNs`, which separates writes that land microseconds apart.
 *
 * The token is opaque to every consumer: the frontend types it as a string
 * and only compares it for equality and echoes it back, `change.ts` only
 * compares it for equality, and it is stored neither in board.yaml nor in
 * browser storage. The format can therefore change without a migration.
 */
export async function revisionOf(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.mtimeNs}:${info.size}`;
  } catch {
    return "absent";
  }
}

export type LoadedBoard = { board: Board; rev: string; exists: boolean };

export async function loadBoard(path: string): Promise<LoadedBoard> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { board: structuredClone(EMPTY_BOARD), rev: "absent", exists: false };
  }
  const rev = await revisionOf(path);
  const text = await file.text();
  const parsed = (Bun.YAML.parse(text) ?? {}) as Partial<Board>;
  const board: Board = {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    updated_at: (parsed.updated_at as string | null) ?? null,
    items: Array.isArray(parsed.items) ? (parsed.items as Item[]) : [],
  };
  if (parsed.commander) board.commander = parsed.commander as SessionLink;
  if (parsed.decisions_required) {
    board.decisions_required = parsed.decisions_required as Json[];
  }
  return { board, rev, exists: true };
}

/**
 * Counter that makes the temporary file name unique inside this process.
 * The pid alone is not enough: two overlapping writes in one process would
 * still collide on the same name.
 */
let tempWriteCounter = 0;

/**
 * Write the board through a temporary file and an atomic rename.
 *
 * The temporary file name carries the pid and a per-call counter. It used to
 * be the fixed `<path>.overlord-tmp`, which two processes writing at the same
 * time both created and both renamed: 92-97% of concurrent write pairs had one
 * side fail with `rename ENOENT` (its temp file had already been renamed away
 * by the other process), and one measured run left board.yaml itself
 * truncated and NUL-padded, after which `Bun.YAML.parse` failed and every
 * server write answered 500 until the file was repaired by hand.
 *
 * A failed write removes its own temporary file, so a full disk or a
 * permission error does not leave `<path>.overlord-tmp.<pid>.<n>` behind.
 */
export async function saveBoard(path: string, board: Board): Promise<string> {
  board.updated_at = nowIso();
  const text = toBlockYaml(orderKeys(board as Json, BOARD_KEY_ORDER));
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.overlord-tmp.${process.pid}.${(tempWriteCounter++).toString(36)}`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(noop);
    throw error;
  }
  return revisionOf(path);
}

/**
 * Raised by `mutateBoard` when the board on disk no longer carries the
 * revision the caller expected. `rev` is the revision actually found, so the
 * caller can hand it back to the client (the console server answers 409 with
 * it) without reading the file again.
 */
export class BoardConflictError extends Error {
  readonly rev: string;

  constructor(rev: string) {
    super("board changed on disk");
    this.name = "BoardConflictError";
    this.rev = rev;
  }
}

/**
 * Raised when the board lock could not be taken within
 * `boardLock.acquireTimeoutMs`. It is a `BoardConflictError`, so the console
 * server answers 409 for it exactly as it does for a stale revision, and the
 * CLI exits non-zero; the `rev` it carries is the revision on disk at the
 * moment the attempt was abandoned.
 */
export class BoardLockError extends BoardConflictError {
  readonly lockPath: string;

  constructor(rev: string, lockPath: string) {
    super(rev);
    this.name = "BoardLockError";
    this.message = `board is locked by another process: ${lockPath}`;
    this.lockPath = lockPath;
  }
}

/**
 * Lock timings. Mutable so a test can shorten them; production code never
 * writes to this object.
 *
 * `acquireTimeoutMs` is how long a writer waits for the lock before it gives
 * up and reports a conflict. `staleAfterMs` is how old a lock file's mtime
 * has to be before it is treated as left behind by a process that died
 * without releasing it.
 */
export const boardLock = {
  acquireTimeoutMs: 5_000,
  staleAfterMs: 30_000,
};

const LOCK_RETRY_MIN_MS = 2;
const LOCK_RETRY_MAX_MS = 25;

export function lockPathFor(boardPath: string): string {
  return `${boardPath}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Decide whether an existing lock file was abandoned, and remove it if so.
 *
 * Returns true when the caller should retry the `wx` create immediately: the
 * lock was removed here, disappeared on its own, or changed while being
 * inspected. Returns false when the lock is held by a live writer.
 *
 * The mtime is read twice with a short random pause in between. That closes
 * the case where two writers see the same abandoned lock at the same moment:
 * whichever one removes it first creates its own lock with a different mtime,
 * and the other observes the change and retries instead of deleting a lock
 * that is now held.
 */
/** True when no process holds this pid, so its lock can be reclaimed. */
async function holderIsGone(lockPath: string): Promise<boolean> {
  const text = await readFile(lockPath, "utf8").catch(() => null);
  const pid = Number((text ?? "").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

async function breakStaleLock(lockPath: string): Promise<boolean> {
  const first = await lockMtimeNs(lockPath);
  if (first === null) return true;
  // The mtime test alone breaks a live holder's lock when the machine sleeps
  // or the clock steps, and makes a crashed holder's fresh lock wedge the
  // board for the full staleness window. The pid settles both.
  if (await holderIsGone(lockPath)) {
    await rm(lockPath, { force: true }).catch(noop);
    return true;
  }
  if (!isStale(first)) return false;

  await sleep(10 + Math.random() * 50);
  const second = await lockMtimeNs(lockPath);
  if (second === null) return true;
  if (second !== first) return true;
  if (!isStale(second)) return false;
  if (!(await holderIsGone(lockPath))) return false;

  await rm(lockPath, { force: true }).catch(noop);
  return true;
}

async function lockMtimeNs(lockPath: string): Promise<bigint | null> {
  try {
    return (await stat(lockPath, { bigint: true })).mtimeNs;
  } catch {
    return null;
  }
}

function isStale(mtimeNs: bigint): boolean {
  const ageMs = Number(BigInt(Date.now()) - mtimeNs / 1_000_000n);
  return ageMs > boardLock.staleAfterMs;
}

/**
 * Take the cross-process lock for one board and return its release function.
 *
 * `open(..., "wx")` is O_EXCL: exactly one process creates the file. Everyone
 * else retries with a capped, jittered backoff until `acquireTimeoutMs`
 * passes, then reports a conflict rather than writing anyway.
 */
async function acquireBoardLock(boardPath: string): Promise<() => Promise<void>> {
  const lockPath = lockPathFor(boardPath);
  // performance.now() is monotonic on Darwin and does not advance while the
  // machine sleeps, so a sleep cannot expire the wait and report a false
  // conflict the moment the machine wakes.
  const deadline = performance.now() + boardLock.acquireTimeoutMs;
  let delay = LOCK_RETRY_MIN_MS;
  await mkdir(dirname(boardPath), { recursive: true });

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { force: true }).catch(noop);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await breakStaleLock(lockPath)) continue;
      if (performance.now() >= deadline) {
        throw new BoardLockError(await revisionOf(boardPath), lockPath);
      }
      await sleep(delay * (0.5 + Math.random()));
      delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
    }
  }
}

/**
 * In-process write queue, keyed by resolved board path.
 *
 * Bun.serve runs request handlers concurrently, so two overlapping writes
 * used to interleave as load/load/save/save and the first save was lost
 * without any conflict being reported. Every mutation for one board path is
 * chained onto the previous one here, so `loadBoard` -> mutate -> `saveBoard`
 * runs as one critical section and a second writer always observes the first
 * writer's revision.
 *
 * The queue only covers this process; the `<board>.lock` file taken inside
 * `applyMutation` covers the other processes (the `change.ts` CLI). Both are
 * needed: the lock alone would make two concurrent handlers in this process
 * spin against each other, and the queue alone left the CLI free to overwrite
 * a console write (measured at 0 conflicts detected in 750 rounds, 2-3% of
 * CLI writes lost, up to 49% of console writes rolled back).
 */
const writeQueues = new Map<string, Promise<unknown>>();

export type BoardMutation<T> = {
  /** The board as it was written. */
  board: Board;
  /** Revision of the file after the save. */
  rev: string;
  /** Whatever the mutate callback returned. */
  result: T;
};

/**
 * The single write path for board.yaml.
 *
 * Serializes against every other `mutateBoard` call for the same path, loads
 * the board inside that critical section, rejects the call with
 * `BoardConflictError` when `expectedRev` is given and does not match what is
 * on disk, applies `mutate`, and writes the result back.
 *
 * `expectedRev` may be omitted (or null/undefined/empty) to write without an
 * optimistic check. Throwing from `mutate` aborts the write: nothing is
 * saved and the error reaches the caller, which is how a handler rejects a
 * request after it has already seen the board.
 */
export async function mutateBoard<T>(
  path: string,
  expectedRev: string | null | undefined,
  mutate: (board: Board) => T | Promise<T>,
): Promise<BoardMutation<T>> {
  // Resolved, so that a relative path from the CLI and the absolute path the
  // server holds queue against each other instead of getting a queue each.
  const key = resolve(path);
  const previous = writeQueues.get(key);
  const run = (previous ? previous.then(noop, noop) : Promise.resolve()).then(
    () => applyMutation(key, expectedRev, mutate),
  );
  const tail = run.then(noop, noop);
  writeQueues.set(key, tail);
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return run;
}

async function applyMutation<T>(
  path: string,
  expectedRev: string | null | undefined,
  mutate: (board: Board) => T | Promise<T>,
): Promise<BoardMutation<T>> {
  const release = await acquireBoardLock(path);
  try {
    const loaded = await loadBoard(path);
    if (expectedRev && expectedRev !== loaded.rev) {
      throw new BoardConflictError(loaded.rev);
    }

    let board = loaded.board;
    let result = await mutate(board);

    // Guard against a writer that does not take the lock at all: a person
    // editing board.yaml in an editor, or an older build. If the file moved
    // while `mutate` ran, that edit is re-read and the mutation is applied on
    // top of it, instead of the edit being overwritten. Every writer that
    // does take the lock is already excluded here, so this normally never
    // fires; it does mean `mutate` has to tolerate being called twice.
    if ((await revisionOf(path)) !== loaded.rev) {
      const reloaded = await loadBoard(path);
      board = reloaded.board;
      result = await mutate(board);
    }

    const rev = await saveBoard(path, board);
    return { board, rev, result };
  } finally {
    await release();
  }
}

function noop(): void {}

export function canonicalItem(item: Item): Item {
  return orderKeys(item as Json, ITEM_KEY_ORDER) as Item;
}

function orderKeys(value: Json, order: string[]): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as { [key: string]: Json };
  const result: { [key: string]: Json } = {};
  for (const key of order) {
    if (key in source) result[key] = source[key]!;
  }
  for (const key of Object.keys(source)) {
    if (!(key in result)) result[key] = source[key]!;
  }
  if (Array.isArray(result.items)) {
    result.items = (result.items as Json[]).map((entry) =>
      orderKeys(entry, ITEM_KEY_ORDER),
    );
  }
  if (Array.isArray(result.changes)) {
    result.changes = (result.changes as Json[]).map((entry) =>
      orderKeys(entry, CHANGE_KEY_ORDER),
    );
  }
  if (result.pr && typeof result.pr === "object" && !Array.isArray(result.pr)) {
    result.pr = orderKeys(result.pr, PR_KEY_ORDER);
  }
  // The nested call orders the delivery's own `pr` as well, through the branch
  // above, so the delivery pull request keeps the same key order as a change's.
  if (
    result.delivery &&
    typeof result.delivery === "object" &&
    !Array.isArray(result.delivery)
  ) {
    result.delivery = orderKeys(result.delivery, DELIVERY_KEY_ORDER);
  }
  return result;
}

/**
 * Minimal block-style YAML emitter.
 *
 * Bun.YAML.stringify emits flow style on one line, which is unreadable in a
 * git diff and in an editor, so board.yaml is serialized here instead.
 */
export function toBlockYaml(value: Json): string {
  const lines: string[] = [];
  emitMapping(value, 0, lines);
  return lines.join("\n") + "\n";
}

function emitMapping(value: Json, indent: number, lines: string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    lines.push(`${" ".repeat(indent)}${scalar(value)}`);
    return;
  }
  const entries = Object.entries(value as { [key: string]: Json });
  if (entries.length === 0) {
    lines.push(`${" ".repeat(indent)}{}`);
    return;
  }
  for (const [key, entry] of entries) {
    emitEntry(key, entry, indent, lines);
  }
}

function emitEntry(
  key: string,
  value: Json,
  indent: number,
  lines: string[],
): void {
  const pad = " ".repeat(indent);
  const name = plainKey(key) ? key : quote(key);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${name}: []`);
      return;
    }
    lines.push(`${pad}${name}:`);
    emitSequence(value, indent + 2, lines);
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as { [key: string]: Json });
    if (entries.length === 0) {
      lines.push(`${pad}${name}: {}`);
      return;
    }
    lines.push(`${pad}${name}:`);
    emitMapping(value, indent + 2, lines);
    return;
  }
  if (typeof value === "string" && value.includes("\n")) {
    lines.push(`${pad}${name}: |-`);
    for (const line of value.replace(/\n+$/, "").split("\n")) {
      lines.push(line.length === 0 ? "" : `${pad}  ${line}`);
    }
    return;
  }
  lines.push(`${pad}${name}: ${scalar(value)}`);
}

function emitSequence(values: Json[], indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  for (const value of values) {
    if (Array.isArray(value)) {
      lines.push(`${pad}-`);
      emitSequence(value, indent + 2, lines);
      continue;
    }
    if (value !== null && typeof value === "object") {
      const nested: string[] = [];
      emitMapping(value, indent + 2, nested);
      if (nested.length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      lines.push(`${pad}- ${nested[0]!.trimStart()}`);
      lines.push(...nested.slice(1));
      continue;
    }
    if (typeof value === "string" && value.includes("\n")) {
      lines.push(`${pad}- |-`);
      for (const line of value.replace(/\n+$/, "").split("\n")) {
        lines.push(line.length === 0 ? "" : `${pad}  ${line}`);
      }
      continue;
    }
    lines.push(`${pad}- ${scalar(value)}`);
  }
}

function plainKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key);
}

function scalar(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return quote(String(value));
}

function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
