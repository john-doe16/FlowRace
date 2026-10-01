// Standalone server: serves the client from public/ and the game over a
// WebSocket at /ws. All game logic lives in server/core.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { WebSocket, WebSocketServer } from 'ws';
import type { Board } from '../shared/board.ts';
import type { ServerMessage } from '../shared/protocol.ts';
import { GuestAuth, MemoryStore } from './adapters/memory.ts';
import { GameServer } from './core/game-server.ts';
import type { ConnId } from './core/ports.ts';
import { PuzzlePool } from './core/puzzle-pool.ts';
import { mulberry32 } from './core/rng.ts';

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};
/** Messages per second a client may send before being disconnected. */
const MAX_MSGS_PER_SEC = 60;

const t0 = performance.now();
const pool = new PuzzlePool(mulberry32((Math.random() * 2 ** 32) >>> 0));
pool.refill(10_000);
console.log(`Puzzle pool ready in ${Math.round(performance.now() - t0)}ms`);

const sockets = new Map<ConnId, WebSocket>();
const game = new GameServer({
  transport: {
    send(conn: ConnId, msg: ServerMessage) {
      const ws = sockets.get(conn);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  },
  auth: new GuestAuth(),
  store: new MemoryStore(),
  clock: { now: () => Date.now() },
  puzzles: pool,
  log: (m) => console.log(m),
});

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  try {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 32 * 1024 });
const alive = new WeakSet<WebSocket>();

wss.on('connection', (ws) => {
  const conn = randomUUID();
  sockets.set(conn, ws);
  alive.add(ws);
  game.handleConnect(conn);

  let windowStart = Date.now();
  let count = 0;

  ws.on('pong', () => alive.add(ws));
  ws.on('message', (data) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    if (++count > MAX_MSGS_PER_SEC) {
      ws.close(1008, 'rate limit');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return;
    }
    game.handleMessage(conn, raw).catch((e) => console.error('handleMessage failed', e));
  });
  ws.on('close', () => {
    sockets.delete(conn);
    game.handleDisconnect(conn);
  });
});

// Drop sockets that stop answering pings (e.g. a phone that went to sleep).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 15_000);

setInterval(() => game.tick(), 100);

// Keep the puzzle pool topped up from a worker thread, one board at a time.
const generator = new Worker(new URL('./puzzle-worker.ts', import.meta.url));
let generating = false;
const feedPool = () => {
  if (generating) return;
  const size = pool.wanted();
  if (size === null) return;
  generating = true;
  generator.postMessage(size);
};
generator.on('message', (board: Board) => {
  pool.add(board);
  generating = false;
  feedPool();
});
generator.on('error', (e) => {
  // Matches still work: the pool falls back to generating on the main thread.
  console.error('puzzle worker failed', e);
  generating = false;
});
setInterval(feedPool, 250);

http.listen(PORT, () => console.log(`Flow Race running at http://localhost:${PORT}`));
