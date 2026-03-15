/**
 * Dashboard DB queries — all read-only, no side effects.
 *
 * Option 3 note: these return plain objects; add a data-layer interface here
 * when moving to React so the frontend can import the same types.
 */

import Database from 'better-sqlite3';

export function openDb(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true });
}

export interface GroupSummary {
  jid: string;
  name: string;
  folder: string;
  channel: string | null;
  agentName: string | null;
  lastMessageTime: string | null;
  messageCount: number;
  isMain: boolean;
}

export interface MessageRow {
  id: string;
  chatJid: string;
  chatName: string | null;
  sender: string;
  senderName: string | null;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
}

export interface TaskRow {
  id: string;
  groupFolder: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  status: string;
  createdAt: string;
}

export interface TaskRunRow {
  id: number;
  taskId: string;
  runAt: string;
  durationMs: number;
  status: string;
  result: string | null;
  error: string | null;
}

export interface HourlyActivity {
  hour: string; // ISO hour bucket e.g. "2026-03-15T08"
  userMessages: number;
  botMessages: number;
}

export interface MetricsSummary {
  totalMessages: number;
  totalUserMessages: number;
  totalBotMessages: number;
  activeGroups: number;
  scheduledTasks: number;
  taskRunsToday: number;
  taskErrorsToday: number;
  avgTaskDurationMs: number | null;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export function getMetricsSummary(db: Database.Database): MetricsSummary {
  const today = new Date().toISOString().slice(0, 10);
  return {
    totalMessages: (db.prepare('SELECT COUNT(*) as n FROM messages').get() as any).n,
    totalUserMessages: (db.prepare('SELECT COUNT(*) as n FROM messages WHERE is_from_me=0 AND is_bot_message=0').get() as any).n,
    totalBotMessages: (db.prepare('SELECT COUNT(*) as n FROM messages WHERE is_bot_message=1').get() as any).n,
    activeGroups: (db.prepare('SELECT COUNT(*) as n FROM registered_groups').get() as any).n,
    scheduledTasks: (db.prepare("SELECT COUNT(*) as n FROM scheduled_tasks WHERE status='active'").get() as any).n,
    taskRunsToday: (db.prepare("SELECT COUNT(*) as n FROM task_run_logs WHERE run_at >= ?").get(today) as any).n,
    taskErrorsToday: (db.prepare("SELECT COUNT(*) as n FROM task_run_logs WHERE run_at >= ? AND status='error'").get(today) as any).n,
    avgTaskDurationMs: ((db.prepare("SELECT AVG(duration_ms) as avg FROM task_run_logs WHERE run_at >= date('now','-7 days')").get() as any).avg) ?? null,
  };
}

export function getGroups(db: Database.Database): GroupSummary[] {
  return (db.prepare(`
    SELECT
      rg.jid, rg.name, rg.folder,
      c.channel, rg.agent_name as agentName,
      c.last_message_time as lastMessageTime,
      rg.is_main as isMain,
      COUNT(m.id) as messageCount
    FROM registered_groups rg
    LEFT JOIN chats c ON c.jid = rg.jid
    LEFT JOIN messages m ON m.chat_jid = rg.jid
    GROUP BY rg.jid
    ORDER BY c.last_message_time DESC NULLS LAST
  `).all() as any[]).map(r => ({ ...r, isMain: !!r.isMain }));
}

export function getRecentMessages(db: Database.Database, limit = 50, chatJid?: string): MessageRow[] {
  const where = chatJid ? 'WHERE m.chat_jid = ?' : '';
  const params = chatJid ? [chatJid, limit] : [limit];
  return (db.prepare(`
    SELECT
      m.id, m.chat_jid as chatJid, c.name as chatName,
      m.sender, m.sender_name as senderName, m.content,
      m.timestamp, m.is_from_me as isFromMe, m.is_bot_message as isBotMessage
    FROM messages m
    LEFT JOIN chats c ON c.jid = m.chat_jid
    ${where}
    WHERE m.is_reaction = 0
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(...params) as any[]).map(r => ({
    ...r,
    isFromMe: !!r.isFromMe,
    isBotMessage: !!r.isBotMessage,
  }));
}

export function getTasks(db: Database.Database): TaskRow[] {
  return db.prepare(`
    SELECT
      id, group_folder as groupFolder, prompt,
      schedule_type as scheduleType, schedule_value as scheduleValue,
      next_run as nextRun, last_run as lastRun,
      last_result as lastResult, status, created_at as createdAt
    FROM scheduled_tasks
    ORDER BY status ASC, next_run ASC
  `).all() as TaskRow[];
}

export function getTaskRuns(db: Database.Database, limit = 100): TaskRunRow[] {
  return db.prepare(`
    SELECT id, task_id as taskId, run_at as runAt,
      duration_ms as durationMs, status, result, error
    FROM task_run_logs
    ORDER BY run_at DESC
    LIMIT ?
  `).all(limit) as TaskRunRow[];
}

export function getHourlyActivity(db: Database.Database, hours = 24): HourlyActivity[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H', timestamp) as hour,
      SUM(CASE WHEN is_bot_message=1 THEN 1 ELSE 0 END) as botMessages,
      SUM(CASE WHEN is_bot_message=0 AND is_from_me=0 THEN 1 ELSE 0 END) as userMessages
    FROM messages
    WHERE timestamp >= ? AND is_reaction=0
    GROUP BY hour
    ORDER BY hour ASC
  `).all(since) as HourlyActivity[];
  return rows;
}
