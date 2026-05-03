'use strict';

const { httpCall } = require('../utils/httpClient');
const logger       = require('../utils/logger');
const { notificationsSentTotal } = require('../utils/metrics');

const NOTIFICATION_SERVICE_URL = () =>
  (process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:4104').replace(/\/$/, '');

const HIGH_VALUE_THRESHOLD = parseFloat(process.env.HIGH_VALUE_THRESHOLD || '50000');

/**
 * Fire-and-forget: never throws, never awaited in the critical path.
 */
function _dispatch(path, payload, correlationId, type) {
  httpCall(
    { method: 'POST', url: `${NOTIFICATION_SERVICE_URL()}${path}`, data: payload },
    correlationId,
    `notification-service:${type}`
  )
    .then(() => {
      notificationsSentTotal.inc({ type, success: 'true' });
      logger.info({ event: 'notification_sent', type, correlationId });
    })
    .catch((err) => {
      notificationsSentTotal.inc({ type, success: 'false' });
      logger.warn({ event: 'notification_failed', type, correlationId, error: err.message });
    });
}

/**
 * Notify Notification Service after a transaction.
 * Automatically routes to /notifications/high-value if amount >= threshold.
 */
function notifyTransaction({ transaction, account, amount, transactionType, correlationId }) {
  const isHighValue = amount >= HIGH_VALUE_THRESHOLD;

  const payload = {
    eventId:       `EVT-${transaction.transaction_id}`,
    eventType:     transactionType,
    sourceService: process.env.SERVICE_NAME || 'transaction-service',
    highValue:     isHighValue,
    correlationId,
    channels:      ['EMAIL'],
    payload: {
      account: {
        accountId:    account.account_id,
        accountNumber: account.account_number,
        customerName: account.customer_name || account.name,
        email:        account.email,
        phone:        account.phone,
      },
      transaction: {
        transactionId:   transaction.transaction_id,
        amount:          { rupees: amount.toFixed(2) },
        transactionType,
        balanceAfter:    transaction.balance_after,
        createdAt:       transaction.created_at,
        channel:         transaction.channel,
      },
    },
  };

  const path = isHighValue ? '/notifications/high-value' : '/notifications';
  _dispatch(path, payload, correlationId, isHighValue ? 'HIGH_VALUE_TRANSACTION' : 'TRANSACTION');
}

/**
 * Notify account status change (e.g., freeze triggered by fraud check).
 */
function notifyAccountStatus({ account, newStatus, correlationId }) {
  const payload = {
    eventId:       `EVT-STATUS-${account.account_id}-${Date.now()}`,
    eventType:     'ACCOUNT_STATUS_UPDATE',
    sourceService: process.env.SERVICE_NAME || 'transaction-service',
    correlationId,
    channels:      ['EMAIL', 'SMS'],
    payload: {
      account: {
        accountId:     account.account_id,
        accountNumber: account.account_number,
        customerName:  account.customer_name,
        email:         account.email,
        phone:         account.phone,
        accountStatus: newStatus,
      },
    },
  };

  _dispatch('/notifications/account-status', payload, correlationId, 'ACCOUNT_STATUS_UPDATE');
}

module.exports = { notifyTransaction, notifyAccountStatus, HIGH_VALUE_THRESHOLD };
