/**
 * NanoClaw Panel — lightweight HTTP dashboard server.
 *
 * Zero new dependencies: uses Node built-in `http` + `better-sqlite3`
 * (already a NanoClaw dep).
 *
 * Option 3 note: this file is the natural seam to swap out for an
 * Express/Fastify app. Keep route handlers in routes.ts so they can be
 * mounted on any framework without changes.
 *
 * Usage:
 *   PANEL_PORT=8080 DB_PATH=./store/messages.db npx tsx src/panel/server.ts
 *
 * Or start programmatically from index.ts:
 *   import { startPanel } from './panel/server';
 *   startPanel({ port: 8080, dbPath: './store/messages.db' });
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './db.js';
import { handleRoute } from './routes.js';
import { panelEvents } from './events.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PanelConfig {
  port: number;
  dbPath: string;
  /** Optional: restrict to localhost only (default true) */
  localhostOnly?: boolean;
}

export function startPanel(config: PanelConfig): http.Server {
  const db = openDb(config.dbPath);
  const publicDir = path.join(__dirname, 'public');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
    const pathname = url.pathname;

    // CORS for local dev (Option 3 React dev server will need this)
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (pathname.startsWith('/api/')) {
      const params = Object.fromEntries(url.searchParams.entries());
      handleRoute(pathname, params, db, panelEvents)
        .then(({ status, body }) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        })
        .catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    // Static files — serve index.html for all non-API routes (SPA-ready)
    const filePath = pathname === '/' || !pathname.includes('.')
      ? path.join(publicDir, 'index.html')
      : path.join(publicDir, pathname);

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
      };
      res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  const host = config.localhostOnly !== false ? '127.0.0.1' : '0.0.0.0';
  server.listen(config.port, host, () => {
    logger.info(`Panel running at http://localhost:${config.port}`);
  });

  return server;
}

// ── Standalone entry point ───────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startPanel({
    port: parseInt(process.env.PANEL_PORT ?? '8080'),
    dbPath: process.env.DB_PATH ?? './store/messages.db',
  });
}
