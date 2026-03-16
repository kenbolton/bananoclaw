/**
 * Route handlers — pure functions, framework-agnostic.
 *
 * Option 3 note: mount these on Express with:
 *   app.get('/api/summary', (req, res) => handleRoute('/api/summary', req.query, db, events).then(...))
 */

import Database from 'better-sqlite3';
import {
  getMetricsSummary,
  getGroups,
  getRecentMessages,
  getTasks,
  getTaskRuns,
  getHourlyActivity,
} from './db.js';
import { PanelEventBus } from './events.js';

interface RouteResult {
  status: number;
  body: unknown;
}

export async function handleRoute(
  pathname: string,
  params: Record<string, string>,
  db: Database.Database,
  events: PanelEventBus,
): Promise<RouteResult> {
  switch (pathname) {
    case '/api/summary':
      return { status: 200, body: getMetricsSummary(db) };

    case '/api/groups':
      return { status: 200, body: getGroups(db) };

    case '/api/messages': {
      const limit = Math.min(parseInt(params.limit ?? '50'), 200);
      const chatJid = params.group || undefined;
      return { status: 200, body: getRecentMessages(db, limit, chatJid) };
    }

    case '/api/tasks':
      return { status: 200, body: getTasks(db) };

    case '/api/task-runs': {
      const limit = Math.min(parseInt(params.limit ?? '100'), 500);
      return { status: 200, body: getTaskRuns(db, limit) };
    }

    case '/api/activity': {
      const hours = Math.min(parseInt(params.hours ?? '24'), 168);
      return { status: 200, body: getHourlyActivity(db, hours) };
    }

    case '/api/events':
      return { status: 200, body: events.recent(parseInt(params.limit ?? '50')) };

    case '/api/debug': {
      // Returns sample timestamps from the DB to help diagnose format issues.
      const rows = db.prepare(
        `SELECT id, timestamp, length(timestamp) as len, CAST(timestamp AS INTEGER) as asInt FROM messages WHERE is_reaction=0 ORDER BY rowid DESC LIMIT 10`
      ).all();
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const count = (db.prepare(
        `SELECT COUNT(*) as n FROM messages WHERE is_reaction=0`
      ).get() as any).n;
      return { status: 200, body: { samples: rows, sinceIso: since, totalNonReaction: count } };
    }

    default:
      return { status: 404, body: { error: 'Not found' } };
  }
}
