import express from 'express';
import { fileURLToPath } from 'node:url';
import { createCatalogRouter } from './catalog.js';
import { createAccountAuth } from './service-auth.js';
import { createBookingRouter } from './booking.js';
import { createAccountGateway } from './account-gateway.js';
import { createRecruitmentRouter } from './recruitment.js';
import { createDispatchRouter } from './dispatch.js';
import { createSchedulingRouter } from './scheduling.js';
import { createShiftRouter } from './shifts.js';
import { createAcceptanceRouter } from './acceptance.js';
import { createDisputeRouter } from './disputes.js';
import { createRemedyRouter } from './remedies.js';
import { createActivityRouter } from './activity.js';
import { createRequestContext } from './observability.js';
import { createPostponementRouter } from './postponement.js';

export function createApp({ pool, accountServiceUrl, internalServiceToken, buildSha = 'development', log }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(createRequestContext({serviceName:'booking-service',buildSha,log}));
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
    app.use(createAccountGateway({ accountServiceUrl }));
    app.use(createCatalogRouter({ pool, authenticate }));
    app.use(createBookingRouter({ pool, authenticate }));
    app.use(createRecruitmentRouter({ pool, authenticate }));
    app.use(createDispatchRouter({ pool, authenticate }));
    app.use(createSchedulingRouter({ pool, authenticate }));
    app.use(createShiftRouter({ pool, authenticate }));
    app.use(createAcceptanceRouter({ pool, authenticate }));
    app.use(createDisputeRouter({ pool, authenticate }));
    app.use(createRemedyRouter({ pool, authenticate }));
    app.use(createActivityRouter({ pool, authenticate }));
    app.use(createPostponementRouter({ pool, authenticate }));
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
