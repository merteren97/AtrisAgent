const MAX_METADATA_STRING_LENGTH = 8 * 1024;
const MAX_METADATA_ARRAY_ITEMS = 64;
const MAX_METADATA_OBJECT_KEYS = 48;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_NODES = 512;

const DUPLICATED_CONTENT_KEYS = new Set(['content', 'thought']);
const PRIORITY_METADATA_KEYS = [
  'id', 'type', 'missionId', 'sequence', 'schemaVersion', 'timestamp', 'turnId', 'runId', 'clientMessageId',
  'agentInstanceId', 'taskId', 'role', 'agentRole', 'assignedRole', 'toolCallId', 'toolName', 'args', 'result',
  'success', 'approvalId', 'approvalType', 'approvalStatus', 'approved', 'decidedBy', 'path', 'command',
  'description', 'error', 'summary', 'status', 'state',
];

export const MAX_STREAM_CONTENT_LENGTH = 1_000_000;

/**
 * Timeline entries are a UI projection of durable events. Keep identity and
 * status fields available for replay/inspectors, but do not retain arbitrarily
 * large tool payloads or duplicate streamed text in every event metadata
 * object.
 */
export function compactTimelineMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  let truncated = false;
  let nodes = 0;

  const compact = (value: unknown, depth: number, key?: string): unknown => {
    // Optional event fields are normal. Do not turn absent IDs/flags into the
    // literal string "undefined", which can create false correlations in the
    // timeline projection.
    if (value === undefined) return undefined;
    // Only the event's own streamed fields are duplicated by TimelineItem.content.
    // A nested tool argument such as args.content remains user-visible data.
    if (depth === 1 && key && DUPLICATED_CONTENT_KEYS.has(key)) return undefined;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.length <= MAX_METADATA_STRING_LENGTH) return value;
      truncated = true;
      return `${value.slice(0, MAX_METADATA_STRING_LENGTH)}\n[metadata truncated]`;
    }
    if (typeof value !== 'object') {
      truncated = true;
      return String(value);
    }
    if (nodes >= MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) {
      truncated = true;
      return '[metadata truncated]';
    }
    nodes += 1;

    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const entry of value.slice(0, MAX_METADATA_ARRAY_ITEMS)) {
        const next = compact(entry, depth + 1);
        if (next !== undefined) result.push(next);
      }
      if (value.length > MAX_METADATA_ARRAY_ITEMS) truncated = true;
      return result;
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entryValue]) => entryValue !== undefined);
    const keys = [
      ...PRIORITY_METADATA_KEYS,
      ...entries.map(([entryKey]) => entryKey),
    ].filter((entryKey, index, ordered) => (
      entries.some(([candidate]) => candidate === entryKey)
        && ordered.indexOf(entryKey) === index
        && !(depth === 0 && DUPLICATED_CONTENT_KEYS.has(entryKey))
    ));
    for (const entryKey of keys.slice(0, MAX_METADATA_OBJECT_KEYS)) {
      const entryValue = (value as Record<string, unknown>)[entryKey];
      const next = compact(entryValue, depth + 1, entryKey);
      if (next !== undefined) result[entryKey] = next;
    }
    if (keys.length > MAX_METADATA_OBJECT_KEYS) truncated = true;
    return result;
  };

  const result = compact(metadata, 0) as Record<string, unknown>;
  if (truncated) result.metadataTruncated = true;
  return result;
}

/** Keep the beginning and the latest output when a single stream is huge. */
export function boundStreamContent(value: string): string {
  if (value.length <= MAX_STREAM_CONTENT_LENGTH) return value;
  const marker = '\n\n[Earlier stream content truncated to protect memory.]\n\n';
  const remaining = Math.max(0, MAX_STREAM_CONTENT_LENGTH - marker.length);
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ''}`;
}
