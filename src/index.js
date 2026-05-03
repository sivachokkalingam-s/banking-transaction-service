'use strict';

require('dotenv').config();

const { initDb, closeDb } = require('./db/init');
const logger = require('./utils/logger');

// Initialise DB before importing app (app.js may use getDb on load)
initDb();

const { runSeed } = require('./seed/seed');
const app = require('./app');

const PORT = parseInt(process.env.PORT || '3003', 10);

async function start() {
  // Auto-seed on first boot
  try {
    await runSeed();
  } catch (err) {
    logger.warn({ event: 'seed_skipped', error: err.message });
  }

  const server = app.listen(PORT, () => {
    logger.info({
      event:   'server_started',
      port:    PORT,
      env:     process.env.NODE_ENV || 'development',
      swagger: `http://localhost:${PORT}/api-docs`,
    }, `Transaction Service listening on :${PORT}`);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  function shutdown(signal) {
    logger.info({ event: 'shutdown_signal', signal }, `Received ${signal} — shutting down gracefully`);
    server.close(() => {
      closeDb();
      logger.info({ event: 'shutdown_complete' });
      process.exit(0);
    });
    // Force exit if graceful shutdown takes > 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException',  (err) => {
    logger.error({ event: 'uncaught_exception', error: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ event: 'unhandled_rejection', reason: String(reason) });
  });
}

start();
