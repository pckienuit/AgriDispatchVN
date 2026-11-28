import express from 'express';
import { parsePagination } from './catalog.js';

const CHANNEL = 'dispatch_user_notifications';
const BATCH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, code) => Object.assign(new Error(code), { status, code });

function parseId(value, code, zero = false) {
  if (Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n || (!zero && BigInt(value) === 0n)) {
    throw fail(400, code);
  }
  return BigInt(value).toString();
}

const dto = row => ({ id: row.id, eventType: row.event_type, entityType: row.entity_type, entityId: row.entity_id,
  title: row.title, body: row.body, payload: row.payload, createdAt: row.created_at.toISOString(), readAt: row.read_at?.toISOString() ?? null });
const unreadSql = `SELECT count(*)::int FROM dispatch.user_notifications WHERE recipient_user_id=$1 AND read_at IS NULL`;

// One LISTEN connection per app when streams are active. Notifications are only wake-up hints;
// polling closes gaps during LISTEN setup/reconnect. All event and count reads are recipient-scoped.
function listener(pool) {
  const subscribers = new Map();
  let client;
  let opening = false;
  function drop() {
    const old = client;
    client = undefined;
    old?.release(true);
  }
  async function ensure() {
    if (pool.options?.max === 1 || client || opening || !subscribers.size) return;
    opening = true;
    try {
      const db = await pool.connect();
      client = db;
      db.on('error', () => { if (client === db) drop(); });
      db.on('end', () => { if (client === db) drop(); });
      db.on('notification', ({ channel, payload }) => {
        if (channel !== CHANNEL || typeof payload !== 'string') return;
        const [id, kind] = payload.split(':');
        for (const wake of subscribers.get(id) ?? []) wake(kind === 'read');
      });
      await db.query(`LISTEN ${CHANNEL}`);
      if (!subscribers.size && client === db) drop();
    } catch {
      drop();
    } finally {
      opening = false;
    }
  }
  return {
    ensure,
    subscribe(id, wake) {
      const callbacks = subscribers.get(id) ?? new Set();
      callbacks.add(wake);
      subscribers.set(id, callbacks);
      void ensure();
      return () => {
        callbacks.delete(wake);
        if (!callbacks.size) subscribers.delete(id);
        if (!subscribers.size && !opening) drop();
      };
    },
  };
}

export function createRealtimeRouter({ pool, authenticate }) {
  const router = express.Router();
  const listeners = listener(pool);
  const handle = work => async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (typeof req.actor?.id !== 'string' || !UUID.test(req.actor.id)) throw fail(401, 'UNAUTHENTICATED');
      await work(req, res);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: { code: error.code } });
      if (/^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/.test(error.code ?? '')) {
        return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
      }
      next(error);
    }
  };

  router.get('/api/events/stream', authenticate, handle((req, res) => {
    let cursor = parseId(req.get('Last-Event-ID') ?? req.query.lastEventId ?? '0', 'INVALID_EVENT_CURSOR', true);
    if (req.method === 'HEAD') return res.type('text/event-stream').end();
    const id = req.actor.id.toLowerCase();
    let closed = false;
    let running = false;
    let pending = false;
    let sync = false;
    let lastUnread;
    const write = frame => {
      // Slow readers reconnect from their last received ID; do not buffer unbounded frames.
      if (!closed && !res.write(frame)) close();
    };
    async function wake(read = false) {
      pending = true;
      sync ||= read;
      if (closed || running) return;
      running = true;
      try {
        while (pending && !closed) {
          pending = false;
          const { rows } = await pool.query(`SELECT * FROM dispatch.user_notifications
            WHERE recipient_user_id=$1 AND id>$2 ORDER BY id LIMIT $3`, [id, cursor, BATCH]);
          for (const row of rows) {
            if (closed) break;
            cursor = row.id;
            write(`id: ${cursor}\nevent: ${row.event_type}\ndata: ${JSON.stringify(dto(row))}\n\n`);
          }
          if (rows.length === BATCH) pending = true;
          if (!pending && !closed) {
            const forced = sync;
            sync = false;
            const { rows: [count] } = await pool.query(`SELECT (${unreadSql}) AS "unreadCount"`, [id]);
            if (forced || count.unreadCount !== lastUnread) {
              lastUnread = count.unreadCount;
              write(`event: unread_sync\ndata: ${JSON.stringify(count)}\n\n`);
            }
          }
        }
      } catch {
        close();
      } finally {
        running = false;
      }
    }
    function close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      globalThis.clearInterval(poll);
      globalThis.clearInterval(heartbeat);
      clearTimeout(lifetime);
      res.end();
    }
    const unsubscribe = listeners.subscribe(id, wake);
    const poll = globalThis.setInterval(() => { void listeners.ensure(); void wake(); }, 2000);
    const heartbeat = globalThis.setInterval(() => write(': keepalive\n\n'), 20000);
    // Limit stale access after logout/revocation; every reconnect introspects the credential again.
    const expiresIn = req.sessionExpiresAt ? Date.parse(req.sessionExpiresAt) - Date.now() : Infinity;
    const lifetime = setTimeout(close, Math.max(1, Math.min(60000, expiresIn)));
    res.on('close', close);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    write(': connected\n\n');
    void wake();
  }));

  router.get('/api/notifications', authenticate, handle(async (req, res) => {
    const { limit, offset } = parsePagination(req.query);
    const { rows: [row] } = await pool.query(`SELECT (SELECT coalesce(json_agg(page ORDER BY page.id DESC),'[]')
      FROM (SELECT n.*, id::text AS notification_id
        FROM dispatch.user_notifications n WHERE recipient_user_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3) page) AS items,
      (${unreadSql}) AS "unreadCount"`, [req.actor.id, limit, offset]);
    const items = row.items.map(item => dto({ ...item, id: item.notification_id,
      created_at: new Date(item.created_at), read_at: item.read_at === null ? null : new Date(item.read_at) }));
    res.json({ items, limit, offset, unreadCount: row.unreadCount });
  }));

  router.post('/api/notifications/read', authenticate, handle(async (req, res) => {
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1) throw fail(400, 'INVALID_READ_TARGET');
    const [selector] = Object.keys(input);
    if (!['id', 'upToId', 'all'].includes(selector) || (selector === 'all' && input.all !== true)) throw fail(400, 'INVALID_READ_TARGET');
    const target = selector === 'all' ? null : parseId(input[selector], 'INVALID_READ_TARGET');
    const condition = { id: 'id=$2', upToId: 'id<=$2', all: '$2::bigint IS NULL' }[selector];
    await pool.query(`WITH marked AS (
        UPDATE dispatch.user_notifications SET read_at=clock_timestamp()
        WHERE recipient_user_id=$1 AND read_at IS NULL AND ${condition} RETURNING id
      ) SELECT pg_notify('${CHANNEL}', $1::uuid::text || ':read') WHERE EXISTS (SELECT 1 FROM marked)`, [req.actor.id, target]);
    const { rows: [count] } = await pool.query(`SELECT (${unreadSql}) AS "unreadCount"`, [req.actor.id]);
    res.json(count);
  }));
  return router;
}
