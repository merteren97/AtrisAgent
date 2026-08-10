export interface SseFrames {
  frames: string[];
  remainder: string;
}

/** Consume complete SSE records while retaining a chunked/partial record. */
export function consumeSseFrames(buffer: string, chunk: string): SseFrames {
  let remaining = buffer + chunk;
  const frames: string[] = [];
  let separator = remaining.match(/\r?\n\r?\n/);
  while (separator?.index !== undefined) {
    frames.push(remaining.slice(0, separator.index).replace(/\r/g, ''));
    remaining = remaining.slice(separator.index + separator[0].length);
    separator = remaining.match(/\r?\n\r?\n/);
  }
  return { frames, remainder: remaining };
}
