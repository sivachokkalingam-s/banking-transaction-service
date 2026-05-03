'use strict';

require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi    = require('swagger-ui-express');

const { correlationId, requestLogger, errorHandler } = require('./middleware/common');
const { register } = require('./utils/metrics');
const txnRoutes    = require('./routes/transactions');
const { getDb }    = require('./db/init');
const logger       = require('./utils/logger');

const app = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/v1/transactions/transfer', rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests', code: 'RATE_LIMITED' },
}));

// ── Correlation ID + logging ──────────────────────────────────────────────────
app.use(correlationId);
app.use(requestLogger);

// ── Swagger / OpenAPI ─────────────────────────────────────────────────────────
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Transaction Service API',
      version: '1.0.0',
      description: 'Banking Transaction Microservice — Group 5, Scalable Services M.Tech',
      contact: { name: 'Group 5' },
    },
    servers: [
      { url: `http://localhost:${process.env.PORT || 3003}`, description: 'Local' },
    ],
    tags: [
      { name: 'Transactions', description: 'Transaction operations' },
      { name: 'Observability', description: 'Health, readiness, metrics' },
    ],
  },
  apis: ['./src/routes/*.js'],
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/openapi.json', (req, res) => res.json(swaggerSpec));

// ── Observability endpoints ───────────────────────────────────────────────────

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Liveness check with DB and dependency status
 *     tags: [Observability]
 *     responses:
 *       200:
 *         description: Service healthy
 */
app.get('/health', (req, res) => {
  let dbStats = {};
  try {
    const db = getDb();
    dbStats = {
      transactions:  db.prepare('SELECT COUNT(*) as n FROM transactions').get().n,
      idempotency:   db.prepare('SELECT COUNT(*) as n FROM idempotency_keys').get().n,
      accountCache:  db.prepare('SELECT COUNT(*) as n FROM account_cache').get().n,
      dailyTotals:   db.prepare('SELECT COUNT(*) as n FROM daily_transfer_totals').get().n,
    };
  } catch (e) {
    return res.status(503).json({ service: 'transaction-service', status: 'unhealthy', error: e.message });
  }

  res.json({
    service:   process.env.SERVICE_NAME    || 'transaction-service',
    version:   process.env.SERVICE_VERSION || '1.0.0',
    status:    'ok',
    timestamp: new Date().toISOString(),
    uptime:    Math.round(process.uptime()),
    database:  dbStats,
    dependencies: {
      accountService:      process.env.ACCOUNT_SERVICE_URL      || 'http://account-service:3002',
      notificationService: process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:4104',
    },
  });
});

/**
 * @openapi
 * /ready:
 *   get:
 *     summary: Kubernetes readiness probe
 *     tags: [Observability]
 *     responses:
 *       200:
 *         description: Ready
 */
app.get('/ready', (req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

/**
 * @openapi
 * /metrics:
 *   get:
 *     summary: Prometheus metrics (OpenMetrics format)
 *     tags: [Observability]
 */
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ── Business routes ───────────────────────────────────────────────────────────
app.use('/v1/transactions', txnRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
