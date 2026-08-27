/**
 * The commander screen mirror registers its refresh function here while it
 * is visible, so senders can nudge it shortly after a send without owning
 * the polling loop.
 */
export const screenRefresh: { current: (() => void) | null } = { current: null };

export function refreshScreenSoon(delayMs: number): void {
  setTimeout(() => screenRefresh.current?.(), delayMs);
}
