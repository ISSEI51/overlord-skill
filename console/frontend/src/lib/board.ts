import type { Board, DecisionEntry, Item, StateData, SurfaceLink } from "./types";

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
