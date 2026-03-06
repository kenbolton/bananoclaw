import { logger } from './logger.js';

export type TrackerStatus = 'received' | 'thinking' | 'working' | 'done' | 'failed';

const EMOJI: Record<TrackerStatus, string> = {
  received: '👀',
  thinking: '💭',
  working: '🔄',
  done: '✅',
  failed: '❌',
};

// Forward-only order for non-terminal states
const ORDER: TrackerStatus[] = ['received', 'thinking', 'working'];

/**
 * Tracks agent processing state for a single message batch and sends
 * emoji reactions to signal progress. Forward-only state machine:
 *   received (👀) → thinking (💭) → working (🔄) → done (✅) / failed (❌)
 */
export class StatusTracker {
  private current: TrackerStatus | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly reactFn: (emoji: string) => Promise<void>,
  ) {}

  async advance(status: TrackerStatus): Promise<void> {
    if (this.isTerminal(this.current)) return;

    // Forward-only for non-terminal states
    if (this.current !== null && !this.isTerminal(status)) {
      const curIdx = ORDER.indexOf(this.current);
      const newIdx = ORDER.indexOf(status);
      if (newIdx <= curIdx) return;
    }

    this.current = status;
    try {
      await this.reactFn(EMOJI[status]);
    } catch (err) {
      logger.debug({ err, status }, 'StatusTracker reaction failed (non-fatal)');
    }

    if (this.isTerminal(status)) {
      this.cleanupTimer = setTimeout(() => this.destroy(), 5000);
    }
  }

  getStatus(): TrackerStatus | null {
    return this.current;
  }

  private isTerminal(s: TrackerStatus | null): boolean {
    return s === 'done' || s === 'failed';
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
