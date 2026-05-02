const client = require('prom-client');

// Enable default metrics (CPU, memory, event loop, etc.)
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'txn_service_' });

// ── RED Metrics ──────────────────────────────────────────────────────────────

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
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

const httpErrorsTotal = new client.Counter({
  name: 'http_errors_total',
  help: 'Total number of HTTP errors (4xx + 5xx)',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

// ── Business Metrics ─────────────────────────────────────────────────────────

const transactionsTotal = new client.Counter({
  name: 'transactions_total',
  help: 'Total number of transactions processed',
  labelNames: ['type', 'status'],
  registers: [register],
});

const failedTransfersTotal = new client.Counter({
  name: 'failed_transfers_total',
  help: 'Total number of failed transfer operations',
  labelNames: ['reason'],
  registers: [register],
});

const balanceCheckLatencyMs = new client.Histogram({
  name: 'balance_check_latency_ms',
  help: 'Latency of balance check calls to Account Service (ms)',
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2000],
  registers: [register],
});

const transferAmountHistogram = new client.Histogram({
  name: 'transfer_amount_inr',
  help: 'Distribution of transfer amounts in INR',
  buckets: [500, 1000, 5000, 10000, 50000, 100000, 200000],
  registers: [register],
});

const idempotentReplayTotal = new client.Counter({
  name: 'idempotent_replay_total',
  help: 'Total idempotent request replays served from cache',
  registers: [register],
});

const dailyLimitBreachTotal = new client.Counter({
  name: 'daily_limit_breach_total',
  help: 'Total number of daily limit breach rejections',
  registers: [register],
});

const notificationLatencyMs = new client.Histogram({
  name: 'notification_call_latency_ms',
  help: 'Latency of calls to Notification Service (ms)',
  buckets: [10, 50, 100, 250, 500, 1000, 3000],
  registers: [register],
});

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDurationMs,
  httpErrorsTotal,
  transactionsTotal,
  failedTransfersTotal,
  balanceCheckLatencyMs,
  transferAmountHistogram,
  idempotentReplayTotal,
  dailyLimitBreachTotal,
  notificationLatencyMs,
};
