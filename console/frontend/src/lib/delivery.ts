/**
 * How a delivery is described to the user.
 *
 * A card accepted into 完了 is delivered by the server: it proposes the card's
 * work to the repository default branch and reports the run over
 * `/api/events`. The wording lives here so that the toast raised when the
 * frame arrives and the card detail that outlives it say the same thing about
 * the same outcome.
 */

import type { DeliveryEvent, DeliveryStatus, Item, PullRequest } from "./types";

/** Sonner's toast flavor for one outcome. */
export type DeliveryTone = "loading" | "success" | "info" | "warning" | "error";

export type DeliveryMessage = {
  title: string;
  /** Extra lines: the reason, the unmerged changes, the warnings. */
  description: string | null;
  tone: DeliveryTone;
};

/**
 * The `skipped` reasons the server and `deliverCard` produce. A run that
 * skipped did not fail: there was nothing to propose, or nowhere to propose
 * it to.
 */
const SKIPPED_REASONS: Record<string, string> = {
  "no-diff": "デフォルトブランチとの差分がありません",
  "same-branch": "配送元と配送先が同じブランチです",
  "no-remote": "リポジトリにリモートが設定されていません",
  "no-repository": "git リポジトリではありません",
};

export function skippedReasonText(reason: string | null | undefined): string {
  if (!reason) return "配送するものがありませんでした";
  return SKIPPED_REASONS[reason] ?? reason;
}

/** `#12`, or null when the pull request has no number on the board. */
export function prLabel(pr: PullRequest | null | undefined): string | null {
  return pr?.number ? `#${pr.number}` : null;
}

/**
 * The URL to link to, or null. Only an https URL is turned into an anchor:
 * the board is a file agents write, so the value is not trusted as a href.
 */
export function safePrUrl(pr: PullRequest | null | undefined): string | null {
  const url = pr?.url ?? null;
  return url && url.startsWith("https://") ? url : null;
}

/** Each status in one line, for the card detail. */
export function deliveryStatusText(status: DeliveryStatus): string {
  switch (status) {
    case "running":
      return "配送中";
    case "created":
      return "成果PRを作成しました";
    case "updated":
      return "成果PRを更新しました";
    case "skipped":
      return "配送するものがありません";
    case "blocked":
      return "未マージの変更が残っています";
    case "failed":
      return "配送に失敗しました";
  }
}

/**
 * What to tell the user about one delivery frame.
 *
 * Every status means something different and gets its own wording: `skipped`
 * is not a failure, `blocked` is the user's turn to act on the changes it
 * names, and only `failed` is an error.
 */
export function describeDelivery(event: DeliveryEvent): DeliveryMessage {
  const lines: string[] = [];
  const label = prLabel(event.pr);
  let title: string;
  let tone: DeliveryTone;

  switch (event.status) {
    case "running":
      title = `${event.card} の成果を配送しています…`;
      tone = "loading";
      break;
    case "created":
      title = label
        ? `${event.card} の成果PR ${label} を作成しました`
        : `${event.card} の成果PRを作成しました`;
      tone = "success";
      break;
    case "updated":
      title = label
        ? `${event.card} の成果PR ${label} を更新しました`
        : `${event.card} の成果PRを更新しました`;
      tone = "success";
      break;
    case "skipped":
      title = `${event.card}: 配送するものがありません`;
      lines.push(skippedReasonText(event.reason));
      tone = "info";
      break;
    case "blocked":
      title = `${event.card}: 未マージの変更が残っています`;
      // The changes themselves, so the user knows what to merge; the reason
      // is only their count.
      if (event.unmerged && event.unmerged.length > 0) lines.push(...event.unmerged);
      else if (event.reason) lines.push(event.reason);
      tone = "warning";
      break;
    case "failed":
      title = `${event.card}: 配送に失敗しました`;
      lines.push(event.reason ?? "理由は記録されていません");
      tone = "error";
      break;
  }

  for (const warning of event.warnings ?? []) lines.push(`警告: ${warning}`);
  return { title, description: lines.length > 0 ? lines.join("\n") : null, tone };
}

/**
 * How long the toast stays up.
 *
 * A failure and a block need reading and name something to act on; a success
 * does not. `running` is bounded rather than left to sonner's default for a
 * loading toast, which never dismisses itself: the outcome frame normally
 * replaces it within seconds, but a frame sent while the event stream was
 * dropped is never delivered, and an unbounded spinner would then claim
 * forever that a finished delivery is still running. An outcome that arrives
 * after the bound opens the toast again.
 */
export function deliveryToastDuration(status: DeliveryStatus): number | undefined {
  if (status === "running") return 180000;
  if (status === "failed" || status === "blocked") return 15000;
  return undefined;
}

/**
 * The delivery to show for a card: the run this session watched, and the
 * record on the board.
 *
 * The two are not interchangeable. Only a run that recorded or attempted a
 * pull request writes `delivery`, so a `skipped` or `blocked` run exists in
 * `live` alone; and a run from before this browser was opened exists in
 * `record` alone.
 */
export type DeliveryView = {
  /** The run this browser watched, `running` frame included. */
  live: DeliveryEvent | null;
  pr: PullRequest | null;
  branch: string | null;
  base: string | null;
  /** The last recorded failure, from the board; live failures are in `live`. */
  error: string | null;
  attemptedAt: string | null;
  /** A run is in flight: the server sent `running` and no outcome yet. */
  running: boolean;
  /** The delivery needs the user: it failed or is blocked. */
  needsRetry: boolean;
};

export function deliveryView(
  item: Item,
  live: DeliveryEvent | null | undefined,
): DeliveryView | null {
  const watched = live ?? null;
  const record = item.delivery ?? null;
  if (!watched && !record) return null;
  const outcome = watched && watched.status !== "running" ? watched : null;
  return {
    live: watched,
    pr: watched?.pr ?? record?.pr ?? null,
    branch: watched?.head ?? record?.branch ?? null,
    base: watched?.base ?? record?.base ?? null,
    error: record?.error ?? null,
    attemptedAt: record?.attempted_at ?? null,
    running: watched?.status === "running",
    // The last thing that happened decides: a watched outcome overrides the
    // board record, so a retry that succeeds hides the button the failure it
    // replaced put there.
    needsRetry: outcome
      ? outcome.status === "failed" || outcome.status === "blocked"
      : !watched && Boolean(record?.error),
  };
}

/**
 * The delivery tag on the board card, or null.
 *
 * A card is read on the board at a glance, so it carries one tag: the run in
 * flight, then the one that needs the user, then the delivery pull request.
 * The last is the point of the tag on a finished card - the number is on the
 * card itself rather than only behind a click.
 */
export function deliveryTag(
  item: Item,
  live: DeliveryEvent | null | undefined,
): { label: string; tone: "running" | "failed" | "pr" } | null {
  const view = deliveryView(item, live);
  if (!view) return null;
  if (view.running) return { label: "配送中", tone: "running" };
  if (view.needsRetry) {
    return {
      label: view.live?.status === "blocked" ? "未マージあり" : "配送失敗",
      tone: "failed",
    };
  }
  const label = prLabel(view.pr);
  return label ? { label: `成果PR ${label}`, tone: "pr" } : null;
}
