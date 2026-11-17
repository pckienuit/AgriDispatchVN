import express from 'express';
import { fileURLToPath } from 'node:url';
import { createCatalogRouter } from './catalog.js';
import { createAccountAuth } from './service-auth.js';
import { createBookingRouter } from './booking.js';

export function createApp({ pool, accountServiceUrl, internalServiceToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
  app.get('/ready', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  if (accountServiceUrl !== undefined || internalServiceToken !== undefined) {
    const authenticate = createAccountAuth({ accountServiceUrl, internalServiceToken });
    app.use(createCatalogRouter({ pool, authenticate }));
    app.use(createBookingRouter({ pool, authenticate }));
  }
  app.use(express.static(fileURLToPath(new URL('../../web/', import.meta.url)), { dotfiles: 'deny' }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON' } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: { code: 'INVALID_REQUEST' } });
    console.error('Request failed', { name: error.name, code: error.code });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  return app;
}
