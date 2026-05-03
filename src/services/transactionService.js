'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/init');
const accountSvc     = require('./accountService');
const notifySvc      = require('./notificationService');
const logger         = require('../utils/logger');
const {
  transactionsTotal,
  failedTransfersTotal,
  dailyLimitRejections,
  idempotencyReplays,
} = require('../utils/metrics');

const DAILY_LIMIT = parseFloat(process.env.DAILY_TRANSFER_LIMIT || '200000');

// ── Idempotency helpers ───────────────────────────────────────────────────────

function _hashRequest(body) {
  // Simple deterministic hash of key fields
  const str = JSON.stringify({
    from:   body.from_account_id,
    to:     body.to_account_id,
    amount: body.amount,
  });
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h.toString(16);
}

function _getIdempotent(key) {
  return getDb()
    .prepare(`SELECT * FROM idempotency_keys WHERE idempotency_key = ?
              AND expires_at > datetime('now')`)
    .get(key);
}

function _storeIdempotent({ key, hash, responseBody, httpStatus, debitTxnId, creditTxnId }) {
  getDb().prepare(`
    INSERT OR REPLACE INTO idempotency_keys
      (idempotency_key, request_hash, response_body, http_status, debit_txn_id, credit_txn_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(key, hash, JSON.stringify(responseBody), httpStatus, debitTxnId || null, creditTxnId || null);
}

// ── Daily limit helpers ───────────────────────────────────────────────────────

function _getDailyTotal(accountId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const row = getDb()
    .prepare('SELECT total_amount FROM daily_transfer_totals WHERE account_id = ? AND transfer_date = ?')
    .get(accountId, today);
  return row ? row.total_amount : 0;
}

function _incrementDailyTotal(accountId, amount) {
  const today = new Date().toISOString().slice(0, 10);
  getDb().prepare(`
    INSERT INTO daily_transfer_totals (account_id, transfer_date, total_amount)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, transfer_date) DO UPDATE SET
      total_amount = total_amount + excluded.total_amount
  `).run(accountId, today, amount);
}

function _checkDailyLimit(accountId, amount) {
  const current = _getDailyTotal(accountId);
  if (current + amount > DAILY_LIMIT) {
    dailyLimitRejections.inc();
    const err = new Error(
      `Daily transfer limit exceeded. Limit: ₹${DAILY_LIMIT.toLocaleString()}, ` +
      `Used: ₹${current.toLocaleString()}, Requested: ₹${amount.toLocaleString()}`
    );
    err.statusCode = 422;
    err.code = 'DAILY_LIMIT_EXCEEDED';
    throw err;
  }
}

// ── Core transaction writer ───────────────────────────────────────────────────

function _insertTransaction({
  accountId, transactionType, amount, currency = 'INR',
  counterpartyId, reference, description, channel, balanceAfter, correlationId, status = 'SUCCESS'
}) {
  const txnId = `TXN-${uuidv4()}`;
  getDb().prepare(`
    INSERT INTO transactions
      (transaction_id, account_id, transaction_type, amount, currency,
       counterparty_id, reference, description, channel, status,
       balance_after, correlation_id)
    VALUES
      (@txnId, @accountId, @transactionType, @amount, @currency,
       @counterpartyId, @reference, @description, @channel, @status,
       @balanceAfter, @correlationId)
  `).run({
    txnId, accountId, transactionType, amount, currency,
    counterpartyId: counterpartyId || null,
    reference:      reference || null,
    description:    description || null,
    channel:        channel || 'ONLINE',
    status,
    balanceAfter:   balanceAfter ?? null,
    correlationId:  correlationId || null,
  });

  return getDb().prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(txnId);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Deposit funds into an account.
 */
async function deposit({ accountId, amount, channel, description, reference, correlationId }) {
  // 1. Validate account
  const account = await accountSvc.getAccount(accountId, correlationId);
  accountSvc.validateAccountForTransaction(account, accountId);

  // 2. Call Account Service to credit
  const updated = await accountSvc.creditAccount(accountId, amount, reference, correlationId);

  // 3. Record transaction
  const txn = _insertTransaction({
    accountId,
    transactionType: 'DEPOSIT',
    amount,
    channel,
    description,
    reference,
    balanceAfter: updated.balance,
    correlationId,
  });

  transactionsTotal.inc({ transaction_type: 'DEPOSIT', status: 'SUCCESS' });

  // 4. Notify (fire-and-forget)
  notifySvc.notifyTransaction({
    transaction: txn, account: updated, amount, transactionType: 'DEPOSIT', correlationId,
  });

  logger.info({ event: 'deposit_success', accountId, amount, txnId: txn.transaction_id, correlationId });
  return txn;
}

/**
 * Withdraw funds from an account.
 */
async function withdraw({ accountId, amount, channel, description, correlationId }) {
  // 1. Validate account
  const account = await accountSvc.getAccount(accountId, correlationId);
  accountSvc.validateAccountForTransaction(account, accountId);

  // 2. Overdraft check
  accountSvc.checkOverdraft(account, amount);

  // 3. Debit via Account Service
  const updated = await accountSvc.debitAccount(accountId, amount, null, correlationId);

  // 4. Record transaction
  const txn = _insertTransaction({
    accountId,
    transactionType: 'WITHDRAWAL',
    amount,
    channel,
    description,
    balanceAfter: updated.balance,
    correlationId,
  });

  transactionsTotal.inc({ transaction_type: 'WITHDRAWAL', status: 'SUCCESS' });
  notifySvc.notifyTransaction({
    transaction: txn, account: updated, amount, transactionType: 'WITHDRAWAL', correlationId,
  });

  logger.info({ event: 'withdrawal_success', accountId, amount, txnId: txn.transaction_id, correlationId });
  return txn;
}

/**
 * Transfer funds between two accounts.
 * Idempotent — returns cached result for duplicate idempotency_key.
 */
async function transfer({ fromAccountId, toAccountId, amount, idempotencyKey, description, channel, correlationId }) {
  // ── Guard: same account
  if (fromAccountId === toAccountId) {
    const err = new Error('Source and destination accounts must be different.');
    err.statusCode = 400;
    err.code = 'SAME_ACCOUNT_TRANSFER';
    throw err;
  }

  // ── Idempotency check
  const reqHash = _hashRequest({ from_account_id: fromAccountId, to_account_id: toAccountId, amount });
  const existing = _getIdempotent(idempotencyKey);
  if (existing) {
    if (existing.request_hash !== reqHash) {
      const err = new Error('Idempotency key reused with different request parameters.');
      err.statusCode = 409;
      err.code = 'IDEMPOTENCY_KEY_CONFLICT';
      throw err;
    }
    idempotencyReplays.inc();
    logger.info({ event: 'idempotency_replay', idempotencyKey, correlationId });
    return { ...JSON.parse(existing.response_body), replay: true };
  }

  // ── Validate both accounts
  const [fromAccount, toAccount] = await Promise.all([
    accountSvc.getAccount(fromAccountId, correlationId),
    accountSvc.getAccount(toAccountId, correlationId),
  ]);

  accountSvc.validateAccountForTransaction(fromAccount, fromAccountId);
  accountSvc.validateAccountForTransaction(toAccount, toAccountId);

  // ── Overdraft check on sender
  accountSvc.checkOverdraft(fromAccount, amount);

  // ── Daily limit check (TRANSFER_OUT only counts toward cap)
  _checkDailyLimit(fromAccountId, amount);

  // ── Execute atomically: debit → credit → record
  let debitTxn, creditTxn;
  let updatedFrom;

  try {
    // Step 1: Debit sender
    updatedFrom = await accountSvc.debitAccount(fromAccountId, amount, idempotencyKey, correlationId);

    // Step 2: Credit receiver
    let updatedTo;
    try {
      updatedTo = await accountSvc.creditAccount(toAccountId, amount, idempotencyKey, correlationId);
    } catch (creditErr) {
      // Step 2 failed → rollback Step 1
      logger.error({
        event: 'credit_failed_rolling_back',
        fromAccountId, toAccountId, amount, correlationId, error: creditErr.message,
      });
      await accountSvc.rollbackDebit(fromAccountId, amount, idempotencyKey, correlationId);

      failedTransfersTotal.inc({ reason: 'credit_failed' });
      transactionsTotal.inc({ transaction_type: 'TRANSFER_OUT', status: 'FAILED' });

      const err = new Error('Transfer failed: could not credit destination account. Debit has been reversed.');
      err.statusCode = 503;
      err.code = 'TRANSFER_CREDIT_FAILED';
      throw err;
    }

    // Step 3: Record both legs in SQLite (single transaction for consistency)
    const db = getDb();
    const insertBoth = db.transaction(() => {
      debitTxn = _insertTransaction({
        accountId:      fromAccountId,
        transactionType: 'TRANSFER_OUT',
        amount,
        counterpartyId: toAccountId,
        reference:      idempotencyKey,
        description,
        channel,
        balanceAfter:   updatedFrom.balance,
        correlationId,
      });
      creditTxn = _insertTransaction({
        accountId:      toAccountId,
        transactionType: 'TRANSFER_IN',
        amount,
        counterpartyId: fromAccountId,
        reference:      idempotencyKey,
        description,
        channel,
        balanceAfter:   updatedTo.balance,
        correlationId,
      });
    });
    insertBoth();

    // Step 4: Update daily limit tracker
    _incrementDailyTotal(fromAccountId, amount);

    transactionsTotal.inc({ transaction_type: 'TRANSFER_OUT', status: 'SUCCESS' });
    transactionsTotal.inc({ transaction_type: 'TRANSFER_IN',  status: 'SUCCESS' });

  } catch (err) {
    if (err.code !== 'TRANSFER_CREDIT_FAILED') {
      failedTransfersTotal.inc({ reason: 'debit_failed' });
    }
    throw err;
  }

  const response = {
    success:            true,
    replay:             false,
    debit_transaction:  debitTxn,
    credit_transaction: creditTxn,
    daily_total_used:   _getDailyTotal(fromAccountId),
    daily_limit:        DAILY_LIMIT,
  };

  // Step 5: Store idempotent response
  _storeIdempotent({
    key:          idempotencyKey,
    hash:         reqHash,
    responseBody: response,
    httpStatus:   201,
    debitTxnId:   debitTxn.transaction_id,
    creditTxnId:  creditTxn.transaction_id,
  });

  // Step 6: Notify (fire-and-forget)
  notifySvc.notifyTransaction({
    transaction: debitTxn, account: fromAccount, amount, transactionType: 'TRANSFER_OUT', correlationId,
  });

  logger.info({
    event: 'transfer_success',
    fromAccountId, toAccountId, amount,
    debitTxnId:  debitTxn.transaction_id,
    creditTxnId: creditTxn.transaction_id,
    correlationId,
  });

  return response;
}

/**
 * List transactions with pagination and filters.
 */
function listTransactions({ accountId, type, status, from, to, limit = 20, offset = 0 }) {
  const conditions = [];
  const params = [];

  if (accountId) { conditions.push('account_id = ?');     params.push(accountId); }
  if (type)      { conditions.push('transaction_type = ?'); params.push(type); }
  if (status)    { conditions.push('status = ?');          params.push(status); }
  if (from)      { conditions.push('created_at >= ?');     params.push(from); }
  if (to)        { conditions.push('created_at <= ?');     params.push(to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const db = getDb();

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM transactions ${where}`).get(...params).cnt;
  const rows  = db.prepare(
    `SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { transactions: rows, total, limit, offset };
}

/**
 * Get single transaction by ID.
 */
function getTransaction(transactionId) {
  return getDb().prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId) || null;
}

/**
 * Account statement — all transactions for an account, with optional filters.
 */
function getStatement({ accountId, type, from, to, limit = 50, offset = 0 }) {
  return listTransactions({ accountId, type, from, to, limit, offset });
}

module.exports = { deposit, withdraw, transfer, listTransactions, getTransaction, getStatement };
