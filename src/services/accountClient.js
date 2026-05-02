const { httpCall } = require('../utils/httpClient');
const { balanceCheckLatencyMs } = require('../utils/metrics');
const logger = require('../utils/logger');

const BASE = process.env.ACCOUNT_SERVICE_URL || 'http://localhost:3002';

/**
 * Fetch account details from Account Service.
 */
async function getAccount(accountId, correlationId) {
  const start = Date.now();
  try {
    const data = await httpCall(
      { method: 'GET', url: `${BASE}/v1/accounts/${accountId}` },
      3,
      correlationId
    );
    balanceCheckLatencyMs.observe(Date.now() - start);
    return data.account || data;
  } catch (err) {
    balanceCheckLatencyMs.observe(Date.now() - start);
    logger.error('getAccount failed', { accountId, error: err.message, correlationId });
    throw err;
  }
}

/**
 * Debit an account – calls PATCH /v1/accounts/:id/debit
 */
async function debitAccount(accountId, amount, correlationId) {
  return httpCall(
    {
      method: 'PATCH',
      url: `${BASE}/v1/accounts/${accountId}/debit`,
      data: { amount },
    },
    3,
    correlationId
  );
}

/**
 * Credit an account – calls PATCH /v1/accounts/:id/credit
 */
async function creditAccount(accountId, amount, correlationId) {
  return httpCall(
    {
      method: 'PATCH',
      url: `${BASE}/v1/accounts/${accountId}/credit`,
      data: { amount },
    },
    3,
    correlationId
  );
}

/**
 * Reverse a debit (used in transfer rollback).
 */
async function reverseDebit(accountId, amount, correlationId) {
  return httpCall(
    {
      method: 'PATCH',
      url: `${BASE}/v1/accounts/${accountId}/credit`,
      data: { amount },
    },
    3,
    correlationId
  );
}

module.exports = { getAccount, debitAccount, creditAccount, reverseDebit };
