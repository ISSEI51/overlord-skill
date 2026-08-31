/** Board and cmux types mirrored from console/src/board.ts and cmux.ts. */

export const STATES = [
  { key: "inbox", label: "受信箱" },
  { key: "discovery", label: "調査中" },
  { key: "specified", label: "実装準備完了" },
  { key: "implementing", label: "実装中" },
  { key: "reviewing", label: "確認中" },
  { key: "acceptance", label: "完成確認待ち" },
  { key: "done", label: "完了" },
  { key: "blocked", label: "停止中" },
] as const;

export type StateKey = (typeof STATES)[number]["key"];

export const ACTIVE_STATES: readonly StateKey[] = [
  "discovery",
  "specified",
  "implementing",
  "reviewing",
  "acceptance",
];

export type SessionLink = {
  workspace_id?: string | null;
  surface_id?: string | null;
  cwd?: string | null;
};

/** Pull request for a change; fields stay null until the PR exists. */
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
 * Read-only in the console: changes are not a human decision unit.
 */
export type Change = {
  id: string;
  title?: string | null;
  state: StateKey;
  agent?: SessionLink | null;
  branch?: string | null;
  pr?: PullRequest | null;
};

/**
 * The card-level delivery record, mirrored from `Delivery` in
 * console/src/board.ts. It is the last attempt to propose the finished card
 * to the repository default branch, rewritten on every attempt: `error` is
 * null after a delivery that recorded a pull request, and carries the
 * diagnostic of the last failure otherwise.
 *
 * A `skipped` or `blocked` run writes no delivery record, so a card can have
 * a live outcome (see `DeliveryEvent`) and nothing here.
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

/**
 * How one delivery run ended, mirrored from `DeliverOutcome["status"]` in
 * console/src/change.ts plus the server's `running`, which it broadcasts when
 * a run starts.
 */
export type DeliveryStatus =
  | "running"
  | "created"
  | "updated"
  | "skipped"
  | "blocked"
  | "failed";

/**
 * The `{"type":"delivery"}` frame of `/api/events`, mirrored from
 * `DeliveryEvent` in console/src/server.ts. `running` carries nothing but the
 * card; every other frame is one `DeliverOutcome` spread into it, so which
 * fields are present depends on `status`:
 *
 * - `created` / `updated`: `pr` is the delivery pull request
 * - `skipped`: `reason` is `no-diff`, `same-branch`, `no-remote` or
 *   `no-repository`
 * - `blocked`: `unmerged` lists the changes that are not merged yet, each
 *   `"<change-id>  <title>"`
 * - `failed`: `reason` is the diagnostic, also written to `delivery.error`
 */
export type DeliveryEvent = {
  type: "delivery";
  card: string;
  status: DeliveryStatus;
  reason?: string | null;
  pr?: PullRequest | null;
  /** Head branch the attempt used; `Delivery.branch` under another name. */
  head?: string | null;
  base?: string | null;
  unmerged?: string[] | null;
  /** Non-fatal problems: the run continued in spite of them. */
  warnings?: string[] | null;
};

export type Priority = {
  impact?: number | null;
  urgency?: number | null;
  confidence?: number | null;
  ease?: number | null;
  override?: string | null;
} | null;

export type Item = {
  id: string;
  project?: string | null;
  title?: string | null;
  state: StateKey;
  priority?: Priority;
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
  brief?: unknown;
  review?: unknown;
};

export type DecisionEntry =
  | string
  | { id?: string | null; question?: string | null; title?: string | null };

export type Board = {
  version: number;
  updated_at?: string | null;
  commander?: SessionLink | null;
  decisions_required?: DecisionEntry[] | null;
  items: Item[];
};

export type Surface = {
  ref: string;
  id: string;
  title: string;
  type: string;
  tty: string | null;
  url: string | null;
  selected: boolean;
  focused: boolean;
};

export type Workspace = {
  ref: string;
  id: string;
  title: string;
  index: number;
  selected: boolean;
  cwd: string | null;
  latestMessage: string | null;
  surfaces: Surface[];
};

export type CmuxInfo = {
  available: boolean;
  error: string | null;
  workspaces: Workspace[];
};

export type StateData = {
  board: Board;
  rev: string;
  exists: boolean;
  boardPath: string;
  projectRoot: string;
  cmux: CmuxInfo;
};

export type SurfaceLink = { workspace: Workspace; surface: Surface };
