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
 * Decide the two card highlights from the board.
 *
 * `running` is decided by the recorded session first and by `owner` second.
 * The two are not equally reliable: `changes[].agent` is written when a
 * session is actually started for that change, while `owner` is a free-text
 * field an agent writes by hand and can forget to update. `owner: "claude"`
 * is still accepted, so a board that records no session keeps the highlight
 * it had, but it is not required: a card with a live session is 作業中
 * whatever `owner` says, or does not say.
 *
 * **When both apply, running wins over needsUser.** Two reasons:
 *
 *  - The signals do not describe the same kind of thing. A live session is a
 *    recorded fact about the present. All three needs-user sources are
 *    statements about what should happen next, and they go stale on their
 *    own: `decisions_required` keeps entries after the decision is settled,
 *    and `owner: "user"` outlives the moment it was written. That is the
 *    reported failure of 2026-09-01: three settled entries in
 *    `decisions_required` kept a card that had been implementing for 29
 *    minutes out of the 作業中 highlight, and the user pressed 進める on it
 *    three times.
 *  - Losing the running highlight costs more than losing the needs-user one.
 *    A card marked 判断待ち while an agent works on it invites the user to
 *    act on unfinished work, which is what happened. A card marked 作業中
 *    that also needs a decision hides nothing: `decisions_required` entries
 *    are always in the 今日の判断 bar, an `acceptance` card sits in the
 *    完成確認待ち column and keeps its 受け入れて完了 button, and `owner` is
 *    shown as a tag on the card and as a field in the modal.
 *
 * Done and blocked cards get neither highlight, whatever the rest says.
 */
export function cardActivity(item: Item, needsUserIds: Set<string>): CardActivity {
  const settled = item.state === "done" || item.state === "blocked";
  const session = settled ? null : liveSession(item);
  const running = !settled && (session !== null || item.owner === "claude");
  const needsUser =
    !settled &&
    !running &&
    (item.state === "acceptance" || item.owner === "user" || needsUserIds.has(item.id));
  return { running, session, needsUser };
}
