'use strict';

const { httpCall } = require('../utils/httpClient');
const { getDb }    = require('../db/init');
const logger       = require('../utils/logger');
const { balanceCheckLatencyMs } = require('../utils/metrics');

const ACCOUNT_SERVICE_URL = () =>
  (process.env.ACCOUNT_SERVICE_URL || 'http://account-service:3002').replace(/\/$/, '');

/**
 * Fetch account from Account Service.
 * Updates local account_cache for future loose-coupled reads.
 * Returns null when Account Service is unavailable (uses cache).
 *
 * @param {string} accountId
 * @param {string} correlationId
 * @returns {Promise<object>} account record
 */
async function getAccount(accountId, correlationId) {
  const end = balanceCheckLatencyMs.startTimer();
  try {
    const res = await httpCall(
      { method: 'GET', url: `${ACCOUNT_SERVICE_URL()}/v1/accounts/${accountId}` },
      correlationId,
      'account-service:getAccount'
    );
    const acct = res.data.account || res.data;
    end();

    // Refresh cache with live data
    _upsertCache(acct);
    return acct;
  } catch (err) {
    end();
    logger.warn({
      event: 'account_service_fallback',
      accountId,
      correlationId,
      error: err.message,
    }, 'Account Service unavailable – falling back to cache');

    // Graceful degradation: use cached record if available
    const cached = _getCached(accountId);
    if (cached) return cached;

    const error = new Error(`Account Service unavailable and no cache for ${accountId}`);
    error.statusCode = 503;
    throw error;
  }
}

/**
 * Validate account is usable for transactions.
 * Checks: status (ACTIVE only), KYC (VERIFIED), account existence.
 *
 * @throws {Error} with statusCode 422 / 403 / 404
 */
function validateAccountForTransaction(account, accountId) {
  if (!account) {
    const err = new Error(`Account ${accountId} not found`);
    err.statusCode = 404;
    throw err;
  }

  if (account.status === 'FROZEN') {
    const err = new Error(`Account ${accountId} is frozen. Transactions are not permitted.`);
    err.statusCode = 422;
    err.code = 'ACCOUNT_FROZEN';
    throw err;
  }

  if (account.status === 'CLOSED') {
    const err = new Error(`Account ${accountId} is closed. Transactions are not permitted.`);
    err.statusCode = 422;
    err.code = 'ACCOUNT_CLOSED';
    throw err;
  }

  if (account.status !== 'ACTIVE') {
    const err = new Error(`Account ${accountId} is not active (status: ${account.status}).`);
    err.statusCode = 422;
    err.code = 'ACCOUNT_INACTIVE';
    throw err;
  }

  // KYC guard — required by assignment spec
  if (account.kyc_status && account.kyc_status !== 'VERIFIED') {
    const err = new Error(
      `Account ${accountId} KYC is ${account.kyc_status}. Transactions require VERIFIED KYC.`
    );
    err.statusCode = 403;
    err.code = 'KYC_NOT_VERIFIED';
    throw err;
  }
}

/**
 * Check overdraft rules by account type.
 * SAVINGS  → balance must cover amount (no overdraft).
 * NRE      → same (regulatory, no overdraft on NRE accounts).
 * CURRENT  → overdraft allowed (business accounts).
 * SALARY   → overdraft allowed up to 1 month's average (simplified: allowed).
 */
function checkOverdraft(account, amount) {
  const noOverdraftTypes = ['SAVINGS', 'NRE'];
  if (noOverdraftTypes.includes(account.account_type)) {
    if (account.balance < amount) {
      const err = new Error(
        `Insufficient balance. Available: ₹${account.balance.toFixed(2)}, Required: ₹${amount.toFixed(2)}`
      );
      err.statusCode = 422;
      err.code = 'INSUFFICIENT_BALANCE';
      throw err;
    }
  }
}

/**
 * Debit an account via Account Service.
 * @returns updated account
 */
async function debitAccount(accountId, amount, reference, correlationId) {
  const res = await httpCall(
    {
      method: 'PATCH',
      url: `${ACCOUNT_SERVICE_URL()}/v1/accounts/${accountId}/debit`,
      data: { amount, reference, correlationId },
    },
    correlationId,
    'account-service:debit'
  );
  const acct = res.data.account || res.data;
  _upsertCache(acct);
  return acct;
}

/**
 * Credit an account via Account Service.
 * @returns updated account
 */
async function creditAccount(accountId, amount, reference, correlationId) {
  const res = await httpCall(
    {
      method: 'PATCH',
      url: `${ACCOUNT_SERVICE_URL()}/v1/accounts/${accountId}/credit`,
      data: { amount, reference, correlationId },
    },
    correlationId,
    'account-service:credit'
  );
  const acct = res.data.account || res.data;
  _upsertCache(acct);
  return acct;
}

/**
 * Reverse a debit (rollback) — called if credit fails.
 */
async function rollbackDebit(accountId, amount, reference, correlationId) {
  try {
    await httpCall(
      {
        method: 'PATCH',
        url: `${ACCOUNT_SERVICE_URL()}/v1/accounts/${accountId}/credit`, // reverse debit = credit back
        data: { amount, reference: `ROLLBACK:${reference}`, correlationId },
      },
      correlationId,
      'account-service:rollbackDebit'
    );
    logger.info({ event: 'debit_rolled_back', accountId, amount, correlationId });
  } catch (rollbackErr) {
    // Log critical alert — manual reconciliation needed
    logger.error({
      event: 'CRITICAL_ROLLBACK_FAILED',
      accountId,
      amount,
      reference,
      correlationId,
      error: rollbackErr.message,
    }, 'CRITICAL: debit rollback failed — manual reconciliation required');
  }
}

// ── Internal cache helpers ────────────────────────────────────────────────────

function _upsertCache(acct) {
  if (!acct || !acct.account_id) return;
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO account_cache
        (account_id, customer_id, customer_name, account_number,
         account_type, balance, currency, status, kyc_status, cached_at, updated_at)
      VALUES
        (@account_id, @customer_id, @customer_name, @account_number,
         @account_type, @balance, @currency, @status, @kyc_status,
         datetime('now'), datetime('now'))
      ON CONFLICT(account_id) DO UPDATE SET
        balance       = excluded.balance,
        status        = excluded.status,
        kyc_status    = excluded.kyc_status,
        customer_name = excluded.customer_name,
        updated_at    = datetime('now')
    `).run({
      account_id:     acct.account_id,
      customer_id:    acct.customer_id || '',
      customer_name:  acct.customer_name || acct.name || null,
      account_number: acct.account_number || null,
      account_type:   acct.account_type || 'SAVINGS',
      balance:        acct.balance ?? 0,
      currency:       acct.currency || 'INR',
      status:         acct.status || 'ACTIVE',
      kyc_status:     acct.kyc_status || 'VERIFIED',
    });
  } catch (e) {
    logger.warn({ event: 'cache_upsert_failed', error: e.message });
  }
}

function _getCached(accountId) {
  try {
    return getDb().prepare('SELECT * FROM account_cache WHERE account_id = ?').get(accountId) || null;
  } catch {
    return null;
  }
}

module.exports = {
  getAccount,
  validateAccountForTransaction,
  checkOverdraft,
  debitAccount,
  creditAccount,
  rollbackDebit,
};
