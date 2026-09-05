export interface BoundedEventQueueOptions<T> {
  maxItems: number;
  maxBytes?: number;
  sizeOf?: (item: T) => number;
}

/**
 * Small in-memory queue for live SSE/WebSocket consumers. Slow clients never
 * retain an unbounded event history: oldest entries are dropped and the drop
 * count lets the transport report a replay gap to the client.
 */
export class BoundedEventQueue<T> {
  private readonly items: T[] = [];
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly sizeOf: (item: T) => number;
  private bytes = 0;
  private dropped = 0;

  constructor(options: BoundedEventQueueOptions<T>) {
    this.maxItems = Math.max(1, Math.floor(options.maxItems));
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes ?? 0));
    this.sizeOf = options.sizeOf || (() => 1);
  }

  enqueue(item: T): void {
    const itemBytes = Math.max(0, this.sizeOf(item));
    if (this.maxBytes > 0 && itemBytes > this.maxBytes) {
      this.dropped += 1;
      return;
    }
    this.items.push(item);
    this.bytes += itemBytes;
    while (this.items.length > this.maxItems || (this.maxBytes > 0 && this.bytes > this.maxBytes)) {
      const removed = this.items.shift();
      if (removed === undefined) break;
      this.bytes -= Math.max(0, this.sizeOf(removed));
      this.dropped += 1;
    }
  }

  dequeue(limit = this.items.length): T[] {
    const count = Math.max(0, Math.floor(limit));
    const output = this.items.splice(0, count);
    for (const item of output) this.bytes -= Math.max(0, this.sizeOf(item));
    return output;
  }

  get length(): number { return this.items.length; }
  get byteLength(): number { return this.bytes; }
  get droppedCount(): number { return this.dropped; }

  takeDroppedCount(): number {
    const count = this.dropped;
    this.dropped = 0;
    return count;
  }

  clear(): void {
    this.items.length = 0;
    this.bytes = 0;
    this.dropped = 0;
  }
}
