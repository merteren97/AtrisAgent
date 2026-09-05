export interface MissionCommandCursor {
  priority: number;
  createdAt: string;
  commandId: string;
}

const CURSOR_VERSION = 1;

export function encodeMissionCommandCursor(cursor: MissionCommandCursor): string {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    p: Math.trunc(cursor.priority),
    t: cursor.createdAt,
    i: cursor.commandId,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeMissionCommandCursor(value: unknown): MissionCommandCursor | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      v?: unknown;
      p?: unknown;
      t?: unknown;
      i?: unknown;
    };
    if (parsed.v !== CURSOR_VERSION
      || !Number.isSafeInteger(parsed.p)
      || typeof parsed.t !== 'string'
      || !parsed.t
      || typeof parsed.i !== 'string'
      || !parsed.i) return null;
    return { priority: Number(parsed.p), createdAt: parsed.t, commandId: parsed.i };
  } catch {
    return null;
  }
}
