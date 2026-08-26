export const DEFAULT_TIMELINE_WINDOW = 160;

export interface TailWindow<T> {
  items: T[];
  hiddenCount: number;
}

export function tailWindow<T>(items: T[], visibleCount: number): TailWindow<T> {
  const count = Math.max(0, Math.floor(visibleCount));
  const hiddenCount = Math.max(0, items.length - count);
  return { items: items.slice(hiddenCount), hiddenCount };
}

export function growTimelineWindow(current: number, total: number, pageSize = DEFAULT_TIMELINE_WINDOW): number {
  return Math.min(total, Math.max(0, current) + Math.max(1, pageSize));
}
