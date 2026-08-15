import type { AgentEvent } from '@atris-agent-code/event-schema';
import { redactSensitiveValue } from './secret-redaction';

export type EventType = AgentEvent['type'];
export type EventSubscriber<T extends AgentEvent = AgentEvent> = (event: T) => void | Promise<void>;
export type WildcardSubscriber = (event: AgentEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export class LocalEventBus {
  private subscribers: Map<string, Set<EventSubscriber<any>>> = new Map();
  private wildcardSubscribers: Set<WildcardSubscriber> = new Set();

  /** Subscribe to a specific event type or all events ('*'). */
  on<T extends EventType>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void | Promise<void>
  ): Unsubscribe;
  on(type: '*', handler: WildcardSubscriber): Unsubscribe;
  on(type: string, handler: EventSubscriber<any>): Unsubscribe {
    if (type === '*') {
      this.wildcardSubscribers.add(handler as WildcardSubscriber);
      return () => {
        this.wildcardSubscribers.delete(handler as WildcardSubscriber);
      };
    }

    if (!this.subscribers.has(type)) this.subscribers.set(type, new Set());
    const handlers = this.subscribers.get(type)!;
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.subscribers.delete(type);
    };
  }

  /** Unsubscribe a handler from a specific event type or wildcard. */
  off<T extends EventType>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void | Promise<void>
  ): void;
  off(type: '*', handler: WildcardSubscriber): void;
  off(type: string, handler: EventSubscriber<any>): void {
    if (type === '*') {
      this.wildcardSubscribers.delete(handler as WildcardSubscriber);
      return;
    }
    const handlers = this.subscribers.get(type);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this.subscribers.delete(type);
    }
  }

  /**
   * Invoke a subscriber without allowing an async rejection to escape as an
   * unhandled promise rejection. Event delivery intentionally remains
   * fire-and-forget; orchestration code that needs ordering owns that ordering.
   */
  private invokeSubscriber(
    handler: EventSubscriber<any> | WildcardSubscriber,
    event: AgentEvent,
    label: string,
  ): void {
    try {
      const result = handler(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void Promise.resolve(result).catch((err) => {
          console.error(`[LocalEventBus] Async error handling ${label}:`, err);
        });
      }
    } catch (err) {
      console.error(`[LocalEventBus] Error handling ${label}:`, err);
    }
  }

  /**
   * Emit a sanitized immutable event to all relevant subscribers. Agent/runtime
   * payloads can contain arbitrary model/tool text, so the event bus is the last
   * common boundary before UI rendering, SQLite persistence and project-memory
   * ingestion. Raw credential-bearing objects are never delivered downstream.
   */
  emit(event: AgentEvent): void {
    const safeEvent = redactSensitiveValue(event) as AgentEvent;

    const handlers = this.subscribers.get(safeEvent.type);
    if (handlers) {
      for (const handler of handlers) {
        this.invokeSubscriber(handler, safeEvent, `event "${safeEvent.type}"`);
      }
    }

    for (const handler of this.wildcardSubscribers) {
      this.invokeSubscriber(handler, safeEvent, 'wildcard event');
    }
  }

  /** Clear all active subscribers. */
  clear(): void {
    this.subscribers.clear();
    this.wildcardSubscribers.clear();
  }

  /** Get count of subscribers for a given type or wildcard. */
  listenerCount(type?: EventType | '*'): number {
    if (!type) {
      let count = this.wildcardSubscribers.size;
      for (const handlers of this.subscribers.values()) count += handlers.size;
      return count;
    }
    if (type === '*') return this.wildcardSubscribers.size;
    return this.subscribers.get(type)?.size ?? 0;
  }
}
