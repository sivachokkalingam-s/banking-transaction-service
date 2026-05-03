'use strict';

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'txn_svc_' });

// ── RED metrics ──────────────────────────────────────────────────────────────

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests by method, route, and status',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDurationMs = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

// ── Business metrics ─────────────────────────────────────────────────────────

const transactionsTotal = new client.Counter({
  name: 'transactions_total',
  help: 'Total transactions processed by type and status',
  labelNames: ['transaction_type', 'status'],
  registers: [register],
});

const failedTransfersTotal = new client.Counter({
  name: 'failed_transfers_total',
  help: 'Total failed transfer attempts by reason',
  labelNames: ['reason'],
  registers: [register],
});

const balanceCheckLatencyMs = new client.Histogram({
  name: 'balance_check_latency_ms',
  help: 'Latency of balance check calls to Account Service in ms',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [register],
});

const dailyLimitRejections = new client.Counter({
  name: 'daily_limit_rejections_total',
  help: 'Transfers rejected due to daily limit breach',
  registers: [register],
});

const notificationsSentTotal = new client.Counter({
  name: 'notifications_sent_total',
  help: 'Notifications dispatched by type',
  labelNames: ['type', 'success'],
  registers: [register],
});

const idempotencyReplays = new client.Counter({
  name: 'idempotency_replays_total',
  help: 'Idempotent /transfer requests that returned cached response',
  registers: [register],
});

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDurationMs,
  transactionsTotal,
  failedTransfersTotal,
  balanceCheckLatencyMs,
  dailyLimitRejections,
  notificationsSentTotal,
  idempotencyReplays,
};
