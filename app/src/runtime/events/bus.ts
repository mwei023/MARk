// src/runtime/events/bus.ts
import { EventEmitter } from 'events';
export const eventBus = new EventEmitter();

// Usage:
// eventBus.emit('alert.generated', { type: 'disk', severity: 'critical', ... })
// eventBus.on('alert.generated', handler)