const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const accountClient = require('./accountClient');
const notificationClient = require('./notificationClient');
const logger = require('../utils/logger');
const {
  transactionsTotal,
  failedTransfersTotal,
  dailyLimitBreachTotal,
  idempotentReplayTotal,
  transferAmountHistogram,
} = require('../utils/metrics');

const DAILY_LIMIT = parseFloat(process.env.DAILY_TRANSFER_LIMIT || '200000');
const HIGH_VALUE = parseFloat(process.env.HIGH_VALUE_THRESHOLD || '50000');

// ── Idempotency Helpers ───────────────────────────────────────────────────────

function getIdempotencyRecord(key) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM idempotency_keys WHERE idempotency_key = ? AND expires_at > CURRENT_TIMESTAMP')
    .get(key);
}

function saveIdempotencyRecord(key, transactionId, responseBody, statusCode) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h TTL
  db.prepare(`
    INSERT INTO idempotency_keys (idempotency_key, transaction_id, response_body, status_code, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, transactionId, JSON.stringify(responseBody), statusCode, expiresAt);
}

// ── Daily Limit Helpers ───────────────────────────────────────────────────────

function getDailyTotal(accountId) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare('SELECT total FROM daily_transfer_totals WHERE account_id = ? AND date = ?')
    .get(accountId, today);
  return row ? row.total : 0;
}

function incrementDailyTotal(accountId, amount) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_transfer_totals (account_id, date, total)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, date) DO UPDATE SET total = total + excluded.total
  `).run(accountId, today, amount);
}

// ── Transaction DB Helpers ────────────────────────────────────────────────────

function insertTransaction(txn) {
  const db = getDb();
  const id = txn.transaction_id || `TXN-${uuidv4().slice(0, 8).toUpperCase()}`;
  db.prepare(`
    INSERT INTO transactions (
      transaction_id, account_id, transaction_type, amount, currency,
      counterparty_account_id, reference, merchant, channel, status,
      balance_after, description, correlation_id
    ) VALUES (
      @transaction_id, @account_id, @transaction_type, @amount, @currency,
      @counterparty_account_id, @reference, @merchant, @channel, @status,
      @balance_after, @description, @correlation_id
    )
  `).run({
    transaction_id: id,
    account_id: txn.account_id,
    transaction_type: txn.transaction_type,
    amount: txn.amount,
    currency: txn.currency || 'INR',
    counterparty_account_id: txn.counterparty_account_id || null,
    reference: txn.reference || null,
    merchant: txn.merchant || null,
    channel: txn.channel || 'ONLINE',
    status: txn.status || 'PENDING',
    balance_after: txn.balance_after || null,
    description: txn.description || null,
    correlation_id: txn.correlation_id || null,
  });
  return getTransactionById(id);
}

function updateTransactionStatus(transactionId, status, balanceAfter) {
  const db = getDb();
  db.prepare(`
    UPDATE transactions
    SET status = ?, balance_after = ?, updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = ?
  `).run(status, balanceAfter, transactionId);
}

function getTransactionById(transactionId) {
  return getDb()
    .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
    .get(transactionId);
}

function getTransactionsByAccount(accountId, filters = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM transactions WHERE account_id = ?';
  const params = [accountId];

  if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
  if (filters.type) { sql += ' AND transaction_type = ?'; params.push(filters.type); }
  if (filters.from) { sql += ' AND created_at >= ?'; params.push(filters.from); }
  if (filters.to) { sql += ' AND created_at <= ?'; params.push(filters.to + 'T23:59:59'); }

  const limit = Math.min(parseInt(filters.limit || '50', 10), 200);
  const offset = parseInt(filters.offset || '0', 10);
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);
  const countRow = db
    .prepare('SELECT COUNT(*) as total FROM transactions WHERE account_id = ?')
    .get(accountId);

  return { transactions: rows, total: countRow.total, limit, offset };
}

// ── Service Methods ───────────────────────────────────────────────────────────

/**
 * Process a deposit into an account.
 */
async function processDeposit({ account_id, amount, channel, description, reference, correlation_id }) {
  logger.info('Processing deposit', { account_id, amount, correlation_id });

  // 1. Validate account via Account Service
  let account;
  try {
    account = await accountClient.getAccount(account_id, correlation_id);
  } catch (err) {
    throw { status: 404, error: `Account ${account_id} not found or service unavailable`, code: 'ACCOUNT_NOT_FOUND' };
  }

  if (account.status === 'FROZEN' || account.status === 'inactive') {
    throw { status: 422, error: 'Account is frozen or inactive', code: 'ACCOUNT_FROZEN' };
  }

  // 2. Create pending transaction record
  const txn = insertTransaction({
    account_id, amount, channel, description, reference,
    transaction_type: 'DEPOSIT',
    status: 'PENDING',
    correlation_id,
  });

  try {
    // 3. Credit via Account Service
    const result = await accountClient.creditAccount(account_id, amount, correlation_id);
    const balanceAfter = result.balance || result.account?.balance;

    // 4. Mark SUCCESS
    updateTransactionStatus(txn.transaction_id, 'SUCCESS', balanceAfter);
    const finalTxn = getTransactionById(txn.transaction_id);

    transactionsTotal.inc({ type: 'DEPOSIT', status: 'SUCCESS' });

    // 5. Notify (fire-and-forget)
    const isHighValue = amount >= HIGH_VALUE;
    if (isHighValue) {
      notificationClient.notifyHighValueTransaction({
        transactionId: txn.transaction_id, accountId: account_id, amount, type: 'DEPOSIT', status: 'SUCCESS',
      }, correlation_id).catch(() => {});
    } else {
      notificationClient.notifyTransaction({
        transactionId: txn.transaction_id, accountId: account_id, amount, type: 'DEPOSIT', status: 'SUCCESS',
      }, correlation_id).catch(() => {});
    }

    logger.info('Deposit successful', { transaction_id: txn.transaction_id, amount, correlation_id });
    return finalTxn;

  } catch (err) {
    updateTransactionStatus(txn.transaction_id, 'FAILED', null);
    transactionsTotal.inc({ type: 'DEPOSIT', status: 'FAILED' });
    logger.error('Deposit failed', { transaction_id: txn.transaction_id, error: err.message });
    throw { status: 502, error: 'Failed to credit account', code: 'CREDIT_FAILED' };
  }
}

/**
 * Process a withdrawal from an account.
 */
async function processWithdrawal({ account_id, amount, channel, description, correlation_id }) {
  logger.info('Processing withdrawal', { account_id, amount, correlation_id });

  let account;
  try {
    account = await accountClient.getAccount(account_id, correlation_id);
  } catch (err) {
    throw { status: 404, error: `Account ${account_id} not found`, code: 'ACCOUNT_NOT_FOUND' };
  }

  if (account.status === 'FROZEN' || account.status === 'inactive') {
    throw { status: 422, error: 'Account is frozen or inactive', code: 'ACCOUNT_FROZEN' };
  }

  // Overdraft prevention for SAVINGS accounts
  const balance = parseFloat(account.balance || 0);
  if ((account.account_type === 'SAVINGS' || account.account_type === 'savings') && balance < amount) {
    transactionsTotal.inc({ type: 'WITHDRAWAL', status: 'FAILED' });
    throw { status: 422, error: `Insufficient balance. Available: ₹${balance.toFixed(2)}`, code: 'INSUFFICIENT_FUNDS' };
  }

  const txn = insertTransaction({
    account_id, amount, channel, description,
    transaction_type: 'WITHDRAWAL',
    status: 'PENDING',
    correlation_id,
  });

  try {
    const result = await accountClient.debitAccount(account_id, amount, correlation_id);
    const balanceAfter = result.balance || result.account?.balance;

    updateTransactionStatus(txn.transaction_id, 'SUCCESS', balanceAfter);
    const finalTxn = getTransactionById(txn.transaction_id);

    transactionsTotal.inc({ type: 'WITHDRAWAL', status: 'SUCCESS' });

    const isHighValue = amount >= HIGH_VALUE;
    if (isHighValue) {
      notificationClient.notifyHighValueTransaction({
        transactionId: txn.transaction_id, accountId: account_id, amount, type: 'WITHDRAWAL', status: 'SUCCESS',
      }, correlation_id).catch(() => {});
    }

    logger.info('Withdrawal successful', { transaction_id: txn.transaction_id, amount, correlation_id });
    return finalTxn;

  } catch (err) {
    updateTransactionStatus(txn.transaction_id, 'FAILED', null);
    transactionsTotal.inc({ type: 'WITHDRAWAL', status: 'FAILED' });
    const accErrMsg = err.response?.error || err.message;
    logger.error('Withdrawal failed', { transaction_id: txn.transaction_id, error: accErrMsg });
    throw { status: err.status || 502, error: accErrMsg || 'Failed to debit account', code: 'DEBIT_FAILED' };
  }
}

/**
 * Process a fund transfer (idempotent).
 * Returns { replay: bool, debit_transaction, credit_transaction }
 */
async function processTransfer({ from_account_id, to_account_id, amount, idempotency_key, description, channel, correlation_id }) {
  logger.info('Processing transfer', { from_account_id, to_account_id, amount, idempotency_key, correlation_id });

  // ── Idempotency check ─────────────────────────────────────────────────────
  const existing = getIdempotencyRecord(idempotency_key);
  if (existing) {
    idempotentReplayTotal.inc();
    logger.info('Idempotent replay', { idempotency_key, correlation_id });
    const cached = JSON.parse(existing.response_body);
    return { ...cached, replay: true };
  }

  // ── Validate same-account transfer ───────────────────────────────────────
  if (from_account_id === to_account_id) {
    throw { status: 400, error: 'Cannot transfer to the same account', code: 'SAME_ACCOUNT' };
  }

  // ── Daily limit check ─────────────────────────────────────────────────────
  const dailyTotal = getDailyTotal(from_account_id);
  if (dailyTotal + amount > DAILY_LIMIT) {
    dailyLimitBreachTotal.inc();
    failedTransfersTotal.inc({ reason: 'daily_limit' });
    throw {
      status: 422,
      error: `Daily transfer limit of ₹${DAILY_LIMIT.toLocaleString('en-IN')} exceeded. Used: ₹${dailyTotal.toFixed(2)}`,
      code: 'DAILY_LIMIT_EXCEEDED',
    };
  }

  // ── Validate both accounts ────────────────────────────────────────────────
  let fromAccount, toAccount;
  try {
    fromAccount = await accountClient.getAccount(from_account_id, correlation_id);
  } catch {
    throw { status: 404, error: `Source account ${from_account_id} not found`, code: 'ACCOUNT_NOT_FOUND' };
  }

  try {
    toAccount = await accountClient.getAccount(to_account_id, correlation_id);
  } catch {
    throw { status: 404, error: `Destination account ${to_account_id} not found`, code: 'ACCOUNT_NOT_FOUND' };
  }

  if (fromAccount.status === 'FROZEN' || fromAccount.status === 'inactive') {
    failedTransfersTotal.inc({ reason: 'frozen_account' });
    throw { status: 422, error: 'Source account is frozen or inactive', code: 'ACCOUNT_FROZEN' };
  }

  if (toAccount.status === 'FROZEN' || toAccount.status === 'inactive') {
    failedTransfersTotal.inc({ reason: 'frozen_destination' });
    throw { status: 422, error: 'Destination account is frozen or inactive', code: 'ACCOUNT_FROZEN' };
  }

  // Overdraft check
  const balance = parseFloat(fromAccount.balance || 0);
  if ((fromAccount.account_type === 'SAVINGS' || fromAccount.account_type === 'savings') && balance < amount) {
    failedTransfersTotal.inc({ reason: 'insufficient_funds' });
    throw { status: 422, error: `Insufficient balance. Available: ₹${balance.toFixed(2)}`, code: 'INSUFFICIENT_FUNDS' };
  }

  // ── Create pending debit + credit records ────────────────────────────────
  const debitTxn = insertTransaction({
    account_id: from_account_id,
    amount,
    channel,
    description: description || `Transfer to ${to_account_id}`,
    transaction_type: 'TRANSFER_DEBIT',
    counterparty_account_id: to_account_id,
    status: 'PENDING',
    correlation_id,
  });

  const creditTxn = insertTransaction({
    account_id: to_account_id,
    amount,
    channel,
    description: description || `Transfer from ${from_account_id}`,
    transaction_type: 'TRANSFER_CREDIT',
    counterparty_account_id: from_account_id,
    status: 'PENDING',
    correlation_id,
  });

  // ── Execute atomically ────────────────────────────────────────────────────
  let debitResult;
  try {
    debitResult = await accountClient.debitAccount(from_account_id, amount, correlation_id);
  } catch (err) {
    updateTransactionStatus(debitTxn.transaction_id, 'FAILED', null);
    updateTransactionStatus(creditTxn.transaction_id, 'FAILED', null);
    failedTransfersTotal.inc({ reason: 'debit_failed' });
    throw { status: err.status || 502, error: err.response?.error || 'Failed to debit source account', code: 'DEBIT_FAILED' };
  }

  let creditResult;
  try {
    creditResult = await accountClient.creditAccount(to_account_id, amount, correlation_id);
  } catch (err) {
    // Rollback: reverse the debit
    logger.error('Credit failed, rolling back debit', { correlation_id });
    await accountClient.reverseDebit(from_account_id, amount, correlation_id).catch(() => {});
    updateTransactionStatus(debitTxn.transaction_id, 'REVERSED', null);
    updateTransactionStatus(creditTxn.transaction_id, 'FAILED', null);
    failedTransfersTotal.inc({ reason: 'credit_failed' });
    throw { status: err.status || 502, error: 'Failed to credit destination account – debit reversed', code: 'CREDIT_FAILED' };
  }

  // ── Mark both SUCCESS ─────────────────────────────────────────────────────
  const fromBalanceAfter = debitResult.balance || debitResult.account?.balance;
  const toBalanceAfter = creditResult.balance || creditResult.account?.balance;

  updateTransactionStatus(debitTxn.transaction_id, 'SUCCESS', fromBalanceAfter);
  updateTransactionStatus(creditTxn.transaction_id, 'SUCCESS', toBalanceAfter);

  // ── Update daily total ────────────────────────────────────────────────────
  incrementDailyTotal(from_account_id, amount);

  transactionsTotal.inc({ type: 'TRANSFER_DEBIT', status: 'SUCCESS' });
  transactionsTotal.inc({ type: 'TRANSFER_CREDIT', status: 'SUCCESS' });
  transferAmountHistogram.observe(amount);

  const finalDebit = getTransactionById(debitTxn.transaction_id);
  const finalCredit = getTransactionById(creditTxn.transaction_id);

  const response = {
    replay: false,
    debit_transaction: finalDebit,
    credit_transaction: finalCredit,
    message: 'Transfer completed successfully',
  };

  // ── Save idempotency record ───────────────────────────────────────────────
  saveIdempotencyRecord(idempotency_key, debitTxn.transaction_id, response, 201);

  // ── Notify (fire-and-forget) ──────────────────────────────────────────────
  const isHighValue = amount >= HIGH_VALUE;
  const notifyPayload = { transactionId: debitTxn.transaction_id, accountId: from_account_id, amount, type: 'TRANSFER', status: 'SUCCESS' };
  if (isHighValue) {
    notificationClient.notifyHighValueTransaction(notifyPayload, correlation_id).catch(() => {});
  } else {
    notificationClient.notifyTransaction(notifyPayload, correlation_id).catch(() => {});
  }

  logger.info('Transfer successful', {
    debit: debitTxn.transaction_id, credit: creditTxn.transaction_id, amount, correlation_id,
  });

  return response;
}

/**
 * Get a single transaction.
 */
function getTransaction(transactionId) {
  const txn = getTransactionById(transactionId);
  if (!txn) throw { status: 404, error: 'Transaction not found', code: 'NOT_FOUND' };
  return txn;
}

/**
 * Get account statement.
 */
function getStatement(accountId, filters) {
  return getTransactionsByAccount(accountId, filters);
}

/**
 * Get all transactions with pagination.
 */
function getAllTransactions(filters = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];

  if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
  if (filters.type) { sql += ' AND transaction_type = ?'; params.push(filters.type); }
  if (filters.account_id) { sql += ' AND account_id = ?'; params.push(filters.account_id); }

  const limit = Math.min(parseInt(filters.limit || '50', 10), 200);
  const offset = parseInt(filters.offset || '0', 10);
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);
  const countRow = db.prepare('SELECT COUNT(*) as total FROM transactions').get();

  return { transactions: rows, total: countRow.total, limit, offset };
}

module.exports = {
  processDeposit,
  processWithdrawal,
  processTransfer,
  getTransaction,
  getStatement,
  getAllTransactions,
};
