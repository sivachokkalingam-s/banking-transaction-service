const router = require('express').Router();
const { getDb } = require('../config/database');
const { register } = require('../utils/metrics');
const { httpCall } = require('../utils/httpClient');
const logger = require('../utils/logger');

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check
 *     description: Returns service health including DB stats and dependency status
 *     tags: [Observability]
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
router.get('/health', async (req, res) => {
  const db = getDb();
  const txnCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
  const idemCount = db.prepare('SELECT COUNT(*) as c FROM idempotency_keys').get().c;
  const seedVersion = db.prepare("SELECT value FROM __meta WHERE key='seedVersion'").get()?.value || 'unknown';
  const seededAt = db.prepare("SELECT value FROM __meta WHERE key='seededAt'").get()?.value || null;

  // Check dependencies (non-blocking)
  const deps = {};
  try {
    await httpCall({ method: 'GET', url: `${process.env.ACCOUNT_SERVICE_URL || 'http://account-service:3002'}/health` }, 0);
    deps.account_service = 'up';
  } catch { deps.account_service = 'down'; }

  try {
    await httpCall({ method: 'GET', url: `${process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:4104'}/health` }, 0);
    deps.notification_service = 'up';
  } catch { deps.notification_service = 'down'; }

  const allDepsUp = Object.values(deps).every(v => v === 'up');

  res.status(200).json({
    service: process.env.SERVICE_NAME || 'transaction-service',
    status: allDepsUp ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.SERVICE_VERSION || '1.0.0',
    database: {
      transactions: txnCount,
      idempotency_keys: idemCount,
      seedVersion,
      seededAt,
    },
    dependencies: deps,
  });
});

/**
 * @openapi
 * /ready:
 *   get:
 *     summary: Readiness probe (Kubernetes)
 *     tags: [Observability]
 *     responses:
 *       200:
 *         description: Service is ready
 */
router.get('/ready', (req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

/**
 * @openapi
 * /metrics:
 *   get:
 *     summary: Prometheus metrics endpoint
 *     tags: [Observability]
 *     responses:
 *       200:
 *         description: OpenMetrics/Prometheus format metrics
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

module.exports = router;
