/** localStorage keys shared with the previous console (fully compatible). */
export const DOCK_WIDTH_KEY = "overlord.dockWidth";
export const SCREEN_OPEN_KEY = "overlord.screenOpen";
export const DOCK_OPEN_KEY = "overlord.dockOpen";

export const DEFAULT_DOCK_WIDTH = 560;

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private windows and blocked storage are fine */
  }
}

/** Dock width bounds: at least 360px, at most 70% of the viewport. */
export function clampDockWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, 360), window.innerWidth * 0.7));
}

export function readDockWidth(): number {
  const stored = Number(readStorage(DOCK_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0
    ? clampDockWidth(stored)
    : DEFAULT_DOCK_WIDTH;
}
