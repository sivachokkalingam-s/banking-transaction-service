const { httpCall } = require('../utils/httpClient');
const { notificationLatencyMs } = require('../utils/metrics');
const logger = require('../utils/logger');

const BASE = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:4104';

/**
 * Fire-and-forget notification. Errors are logged but never thrown.
 */
async function sendNotification(payload, correlationId) {
  const start = Date.now();
  const endpoint = payload.highValue
    ? `${BASE}/notifications/high-value`
    : `${BASE}/notifications`;

  try {
    const result = await httpCall(
      { method: 'POST', url: endpoint, data: payload },
      1, // single attempt – notifications are best-effort
      correlationId
    );
    notificationLatencyMs.observe(Date.now() - start);
    logger.info('Notification sent', { correlationId, endpoint });
    return result;
  } catch (err) {
    notificationLatencyMs.observe(Date.now() - start);
    logger.warn('Notification send failed (non-fatal)', {
      error: err.message,
      correlationId,
      endpoint,
    });
    // intentionally swallowed – notifications must not break transaction flow
    return null;
  }
}

/**
 * Build and fire a high-value transaction notification.
 */
async function notifyHighValueTransaction(txnInfo, correlationId) {
  const payload = {
    eventId: `evt-hv-${txnInfo.transactionId}`,
    eventType: 'HIGH_VALUE_TRANSACTION',
    sourceService: 'transaction-service',
    highValue: true,
    correlationId,
    idempotencyKey: `notif-${txnInfo.transactionId}`,
    channels: ['EMAIL'],
    payload: {
      account: {
        accountId: txnInfo.accountId,
        customerId: txnInfo.customerId,
      },
      transaction: {
        transactionId: txnInfo.transactionId,
        amount: { rupees: String(txnInfo.amount) },
        transactionType: txnInfo.type,
        status: txnInfo.status,
      },
    },
  };
  return sendNotification(payload, correlationId);
}

/**
 * Fire a standard transaction notification.
 */
async function notifyTransaction(txnInfo, correlationId) {
  const payload = {
    eventId: `evt-txn-${txnInfo.transactionId}`,
    eventType: 'TRANSACTION_COMPLETED',
    sourceService: 'transaction-service',
    highValue: false,
    correlationId,
    idempotencyKey: `notif-${txnInfo.transactionId}`,
    channels: ['EMAIL'],
    payload: {
      account: { accountId: txnInfo.accountId },
      transaction: {
        transactionId: txnInfo.transactionId,
        amount: { rupees: String(txnInfo.amount) },
        transactionType: txnInfo.type,
        status: txnInfo.status,
      },
    },
  };
  return sendNotification(payload, correlationId);
}

module.exports = { notifyHighValueTransaction, notifyTransaction };
