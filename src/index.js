require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const rateLimit = require('express-rate-limit');

const { initializeDatabase } = require('./config/database');
const swaggerSpec = require('./config/swagger');
const { requestContext, errorHandler, notFoundHandler } = require('./middleware/requestMiddleware');
const logger = require('./utils/logger');

const healthRouter = require('./routes/health');
const transactionRouter = require('./routes/transactions');

const app = express();
const PORT = process.env.PORT || 3003;

// ── Security & Parsing ────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests', code: 'RATE_LIMITED' },
});
app.use(limiter);

// ── Request Logging (Morgan → Winston) ───────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// ── Correlation ID & Metrics ──────────────────────────────────────────────────
app.use(requestContext);

// ── Swagger Docs ──────────────────────────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Transaction Service API',
  customCss: '.swagger-ui .topbar { background-color: #1a237e; }',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
  },
}));

app.get('/openapi.yaml', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(swaggerSpec);
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/', healthRouter);
app.use('/v1/transactions', transactionRouter);

// ── Error Handling ────────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  try {
    initializeDatabase();

    // Auto-seed on first boot if DB is empty
    const { getDb } = require('./config/database');
    const db = getDb();
    const hasData = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c > 0;
    if (!hasData) {
      logger.info('No data found – running seed...');
      try {
        require('./seed/seed');
      } catch (e) {
        logger.warn('Seed failed (non-fatal)', { error: e.message });
      }
    }

    app.listen(PORT, () => {
      logger.info(`Transaction Service started`, {
        port: PORT,
        env: process.env.NODE_ENV,
        swagger: `http://localhost:${PORT}/api-docs`,
        health: `http://localhost:${PORT}/health`,
        metrics: `http://localhost:${PORT}/metrics`,
      });
    });
  } catch (err) {
    logger.error('Failed to start service', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();

module.exports = app;
