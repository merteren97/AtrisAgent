export interface EventCursor {
  sequence: number;
  eventId?: string;
}

const CURSOR_VERSION = 1;

export function encodeEventCursor(cursor: EventCursor): string {
  const sequence = Math.max(0, Math.floor(cursor.sequence));
  const payload = JSON.stringify({ v: CURSOR_VERSION, s: sequence, i: cursor.eventId || undefined });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeEventCursor(value: unknown): EventCursor | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: unknown; s?: unknown; i?: unknown };
    if (parsed.v !== CURSOR_VERSION || !Number.isSafeInteger(parsed.s) || Number(parsed.s) < 0) return null;
    return {
      sequence: Number(parsed.s),
      eventId: typeof parsed.i === 'string' && parsed.i ? parsed.i : undefined,
    };
  } catch {
    return null;
  }
}

export function cursorFromQuery(query: { cursor?: unknown; afterSequence?: unknown }): EventCursor {
  const cursor = decodeEventCursor(query.cursor);
  if (cursor) return cursor;
  const legacy = Number(query.afterSequence || 0);
  return { sequence: Number.isSafeInteger(legacy) && legacy > 0 ? legacy : 0 };
}
