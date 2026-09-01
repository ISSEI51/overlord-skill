import { STATES } from "./types";
import type {
  Board,
  Change,
  DecisionEntry,
  Item,
  SessionLink,
  StateData,
  StateKey,
  SurfaceLink,
} from "./types";

/** Board ids referenced in prose, e.g. "OV-CON-011" or "OV-017". */
export function findIdInText(text: unknown): string | null {
  const match = String(text).match(/\b[A-Z]{2,6}-[A-Z0-9]{1,6}-?\d{2,4}\b/);
  return match ? match[0] : null;
}

export function decisionText(entry: DecisionEntry): string {
  return typeof entry === "string" ? entry : (entry.question ?? entry.title ?? "");
}

export function decisionId(entry: DecisionEntry): string | null {
  return typeof entry === "object" && entry !== null
    ? (entry.id ?? null)
    : findIdInText(entry);
}

export function decisionIds(board: Board): Set<string> {
  const ids = new Set<string>();
  for (const entry of board.decisions_required ?? []) {
    const id = decisionId(entry);
    if (id) ids.add(id);
  }
  return ids;
}

export function scoreOf(item: Item): string | null {
  const priority = item.priority;
  if (!priority) return null;
  const values = [priority.impact, priority.urgency, priority.confidence, priority.ease]
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return `${total}/${values.length * 5}`;
}

export function terminalSurfaces(data: StateData | null): SurfaceLink[] {
  const workspaces = data?.cmux.workspaces ?? [];
  return workspaces.flatMap((workspace) =>
    workspace.surfaces
      .filter((surface) => surface.type === "terminal")
      .map((surface) => ({ workspace, surface })),
  );
}

export function commanderLink(data: StateData | null): SurfaceLink | null {
  const id = data?.board.commander?.surface_id;
  if (!id) return null;
  return terminalSurfaces(data).find((entry) => entry.surface.id === id) ?? null;
}

export function surfaceLabel(link: SurfaceLink): string {
  return `${link.workspace.title || link.workspace.ref} / ${link.surface.title || link.surface.ref}`;
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function stateLabel(state: StateKey): string {
  return STATES.find((entry) => entry.key === state)?.label ?? state;
}

export function changesOf(item: Item): Change[] {
  return item.changes ?? [];
}

/** done / total, or null when the card has no engineering split. */
export function changeProgress(item: Item): { done: number; total: number } | null {
  const changes = changesOf(item);
  if (changes.length === 0) return null;
  return {
    done: changes.filter((change) => change.state === "done").length,
    total: changes.length,
  };
}

/**
 * The session to show for a card. A change owns its agent (1 change =
 * 1 agent execution unit), so the first unfinished change with a session
 * wins; the card-level `agent` stays as the compatibility fallback.
 */
export function activeSession(
  item: Item,
): { agent: SessionLink; changeId: string | null } | null {
  for (const change of changesOf(item)) {
    if (change.state === "done" || change.state === "blocked") continue;
    if (change.agent?.surface_id) return { agent: change.agent, changeId: change.id };
  }
  for (const change of changesOf(item)) {
    if (change.agent?.surface_id) return { agent: change.agent, changeId: change.id };
  }
  if (item.agent?.surface_id) return { agent: item.agent, changeId: null };
  return null;
}

/** True when the card or any of its changes points at a cmux session. */
export function hasSession(item: Item): boolean {
  return activeSession(item) !== null;
}

/**
 * The session of a change that is still in flight: the first change that is
 * neither done nor blocked and that has an `agent.surface_id` recorded.
 *
 * This is the strict half of `activeSession`. `activeSession` answers "which
 * session should the card show", so it falls back to a finished change and
 * then to the card-level `agent`; this one answers "is work running right
 * now", so it accepts neither. The card-level `agent` is accepted only on a
 * card that has no `changes` at all - it is the compatibility field for
 * boards written before `changes` existed, and on such a card the card's own
 * state (checked by `cardActivity`) is the only liveness signal there is.
 */
export function liveSession(
  item: Item,
): { agent: SessionLink; changeId: string | null } | null {
  const changes = changesOf(item);
  for (const change of changes) {
    if (change.state === "done" || change.state === "blocked") continue;
    if (change.agent?.surface_id) return { agent: change.agent, changeId: change.id };
  }
  if (changes.length === 0 && item.agent?.surface_id) {
    return { agent: item.agent, changeId: null };
  }
  return null;
}

/** How a card is highlighted, and whether it can take another instruction. */
export type CardActivity = {
  /** An AI is working on this card right now. */
  running: boolean;
  /** The in-flight session that makes it running, or null when there is none. */
  session: { agent: SessionLink; changeId: string | null } | null;
  /** The user has something to decide or accept on this card. */
  needsUser: boolean;
};

/**
 * Decide the two card highlights from the board. A card gets at most one of
 * them: they are mutually exclusive, decided in this order.
 *
 *   1. An unfinished worker session is recorded -> 作業中.
 *   2. Otherwise a needs-user signal - state `acceptance`, `owner: "user"`,
 *      or an entry in `decisions_required` naming the card -> 判断待ち.
 *   3. Otherwise `owner: "claude"` -> 作業中.
 *
 * The session sits above the needs-user signals and `owner` sits below them,
 * because the two running signals are not equally reliable. `changes[].agent`
 * is written when a session is actually started for that change, so it
 * records the present. `owner` is free text an agent writes by hand and can
 * forget to update, so it only claims the present. `owner: "claude"` is still
 * read - a board that records no session keeps the highlight it had - but it
 * may not cancel a needs-user signal: a card left at `owner: "claude"` after
 * the work stopped would otherwise hide an acceptance or an open decision.
 *
 * **A recorded session does cancel them, and that is the one place 作業中
 * wins over 判断待ち.** Two reasons, both specific to the session:
 *
 *  - It is a different kind of statement. A session that is running now is a
 *    fact about the present. All three needs-user sources say what should
 *    happen next, and they go stale on their own: `decisions_required` keeps
 *    an entry until someone removes it, and `owner: "user"` outlives the
 *    moment it was written. That is the reported failure of 2026-09-01:
 *    three settled entries in `decisions_required` kept a card that had been
 *    implementing for 29 minutes out of the 作業中 highlight, and the user
 *    pressed 進める on it three times.
 *  - The two mistakes do not cost the same. A card marked 判断待ち while a
 *    session works it invites the user to act on unfinished work, which is
 *    what happened. A card marked 作業中 while a decision is open keeps the
 *    decision visible elsewhere: an `acceptance` card sits in the 完成確認待ち
 *    column with its 受け入れて完了 button, `owner` is a tag on the card and
 *    a field in the modal, and a `decisions_required` entry is in the
 *    今日の判断 bar when it is one of the three that bar shows. That last one
 *    is the weakest of the three - the bar is capped at three entries - which
 *    is one more reason to remove an entry once the decision is made.
 *
 * Done and blocked cards get neither highlight, whatever the rest says.
 */
export function cardActivity(item: Item, needsUserIds: Set<string>): CardActivity {
  const settled = item.state === "done" || item.state === "blocked";
  const session = settled ? null : liveSession(item);
  // Only the session suppresses the needs-user highlight. Deciding this
  // before `running` is what keeps `owner: "claude"` from suppressing it.
  const needsUser =
    !settled &&
    session === null &&
    (item.state === "acceptance" || item.owner === "user" || needsUserIds.has(item.id));
  const running = !settled && !needsUser && (session !== null || item.owner === "claude");
  return { running, session, needsUser };
}
