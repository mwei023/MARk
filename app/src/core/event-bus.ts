/**
 * Event Bus: The nervous system of Mark.
 * Pub/sub mechanism for routing events to handlers and agents.
 */

import { EventEmitter } from 'events';
import { Event, EventType } from './events';

export type EventHandler = (event: Event) => Promise<void> | void;

/**
 * Central event bus for Mark's operations.
 * All events flow through here - external webhooks, user commands, agent actions.
 */
export class EventBus extends EventEmitter {
  private handlers: Map<EventType, Set<EventHandler>> = new Map();
  private eventHistory: Event[] = [];
  private maxHistorySize = 10000;

  constructor() {
    super();
    this.setMaxListeners(100); // Agents + webhooks
  }

  /**
   * Subscribe to a specific event type
   */
  subscribe(eventType: EventType | EventType[], handler: EventHandler): () => void {
    const types = Array.isArray(eventType) ? eventType : [eventType];

    types.forEach(type => {
      if (!this.handlers.has(type)) {
        this.handlers.set(type, new Set());
      }
      this.handlers.get(type)!.add(handler);
    });

    // Return unsubscribe function
    return () => {
      types.forEach(type => {
        this.handlers.get(type)?.delete(handler);
      });
    };
  }

  /**
   * Subscribe to all events (wildcard)
   */
  subscribeAll(handler: EventHandler): () => void {
    this.on('*', handler as any);
    return () => this.removeListener('*', handler as any);
  }

  /**
   * Emit an event to all subscribers
   */
  override emit(event: Event): Promise<void>;
  override emit(eventName: string | symbol, ...args: any[]): boolean;
  override emit(eventOrName: string | symbol | Event, ...args: any[]): Promise<void> | boolean {
    if (typeof eventOrName !== 'string' && typeof eventOrName !== 'symbol') {
      return this.publish(eventOrName as Event);
    }
    return super.emit(eventOrName, ...args);
  }

  async publish(event: Event): Promise<void> {
    // Track in history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    super.emit('*', event);

    // Notify type-specific subscribers
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      const promises: Promise<void>[] = [];
      for (const handler of handlers) {
        try {
          const result = handler(event);
          if (result instanceof Promise) {
            promises.push(result);
          }
        } catch (error) {
          console.error(`[EventBus] Error in handler for ${event.type}:`, error);
        }
      }
      await Promise.all(promises);
    }
  }

  /**
   * Get event history for a correlation ID
   */
  getEventChain(correlationId: string): Event[] {
    return this.eventHistory.filter(e => e.correlationId === correlationId);
  }

  /**
   * Get recent events by type
   */
  getRecentEvents(type: EventType, limit: number = 10): Event[] {
    return this.eventHistory
      .filter(e => e.type === type)
      .slice(-limit);
  }

  /**
   * Clear history (useful for testing)
   */
  clearHistory(): void {
    this.eventHistory = [];
  }
}

// Singleton instance
export const eventBus = new EventBus();
