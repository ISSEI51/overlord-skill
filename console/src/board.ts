/**
 * board.yaml access.
 *
 * `docs/product-ops/board.yaml` stays the single machine-readable source of
 * truth. The console reads it, writes it back in block YAML, and detects
 * concurrent writes by an agent through a revision token.
 */

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
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
  "updated_at",
];

const CHANGE_KEY_ORDER = ["id", "title", "state", "agent", "branch", "pr"];

const PR_KEY_ORDER = ["number", "url", "state", "head_sha", "reviewed_sha"];

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

export async function saveBoard(path: string, board: Board): Promise<string> {
  board.updated_at = nowIso();
  const text = toBlockYaml(orderKeys(board as Json, BOARD_KEY_ORDER));
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.overlord-tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, path);
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
 * In-process write queue, keyed by resolved board path.
 *
 * Bun.serve runs request handlers concurrently, so two overlapping writes
 * used to interleave as load/load/save/save and the first save was lost
 * without any conflict being reported. Every mutation for one board path is
 * chained onto the previous one here, so `loadBoard` -> mutate -> `saveBoard`
 * runs as one critical section and a second writer always observes the first
 * writer's revision.
 *
 * This only serializes writers inside this process; writers in another
 * process (the `change.ts` CLI) are still caught by the `expectedRev` check,
 * which now runs inside the same critical section as the save.
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
  const previous = writeQueues.get(path);
  const run = (previous ? previous.then(noop, noop) : Promise.resolve()).then(
    () => applyMutation(path, expectedRev, mutate),
  );
  const tail = run.then(noop, noop);
  writeQueues.set(path, tail);
  void tail.then(() => {
    if (writeQueues.get(path) === tail) writeQueues.delete(path);
  });
  return run;
}

async function applyMutation<T>(
  path: string,
  expectedRev: string | null | undefined,
  mutate: (board: Board) => T | Promise<T>,
): Promise<BoardMutation<T>> {
  const loaded = await loadBoard(path);
  if (expectedRev && expectedRev !== loaded.rev) {
    throw new BoardConflictError(loaded.rev);
  }
  const result = await mutate(loaded.board);
  const rev = await saveBoard(path, loaded.board);
  return { board: loaded.board, rev, result };
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
