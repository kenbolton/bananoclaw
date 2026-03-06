export type AgentStatus =
  | 'received'
  | 'thinking'
  | 'working'
  | 'done'
  | 'failed';

const EMOJI: Record<AgentStatus, string> = {
  received: '👀',
  thinking: '💭',
  working: '🔄',
  done: '✅',
  failed: '❌',
};

const ORDER: AgentStatus[] = [
  'received',
  'thinking',
  'working',
  'done',
  'failed',
];

/**
 * Forward-only emoji status state machine.
 * Applies emoji reactions to the triggering message as the agent progresses.
 * received (👀) → thinking (💭) → working (🔄) → done (✅) / failed (❌)
 */
export class StatusTracker {
  private current: AgentStatus;
  private terminal = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reactFn: (emoji: string) => Promise<void>;

  constructor(reactFn: (emoji: string) => Promise<void>) {
    this.reactFn = reactFn;
    this.current = 'received';
    this.reactFn(EMOJI['received']).catch(() => {});
  }

  async advance(status: AgentStatus): Promise<void> {
    if (this.terminal) return;

    const currentIdx = ORDER.indexOf(this.current);
    const targetIdx = ORDER.indexOf(status);

    // Forward-only: skip if target is at or behind current
    if (targetIdx <= currentIdx) return;

    this.current = status;
    await this.reactFn(EMOJI[status]).catch(() => {});

    if (status === 'done' || status === 'failed') {
      this.terminal = true;
      // Auto-cleanup after 5 seconds so stale trackers don't linger
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = null;
      }, 5000);
    }
  }

  destroy(): void {
    this.terminal = true;
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
