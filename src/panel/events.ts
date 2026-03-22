/**
 * Panel EventBus — thin EventEmitter wrapper.
 *
 * Option 3 note: swap the polling in the frontend for a WebSocket that
 * subscribes to events emitted here. index.ts (or container-runner.ts)
 * should call `panelEvents.emit('agent:start' | 'agent:done' | 'agent:error', payload)`
 * when those lifecycle points are reached.
 */

import { EventEmitter } from 'events';

export type PanelEventType =
  | 'agent:start'
  | 'agent:done'
  | 'agent:error'
  | 'task:run'
  | 'message:in'
  | 'message:out';

export interface AgentEvent {
  type: PanelEventType;
  groupFolder: string;
  chatJid?: string;
  durationMs?: number;
  tokenUsage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
  timestamp: string;
}

export class PanelEventBus extends EventEmitter {
  private history: AgentEvent[] = [];
  private readonly maxHistory = 200;

  emit(
    event: PanelEventType,
    payload: Omit<AgentEvent, 'type' | 'timestamp'>,
  ): boolean {
    const full: AgentEvent = {
      type: event,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    this.history.push(full);
    if (this.history.length > this.maxHistory) this.history.shift();
    return super.emit(event, full);
  }

  /** Last N events — used by /api/events endpoint and future WS. */
  recent(n = 50): AgentEvent[] {
    return this.history.slice(-n);
  }
}

export const panelEvents = new PanelEventBus();
