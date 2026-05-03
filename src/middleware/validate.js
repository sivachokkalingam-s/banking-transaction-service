'use strict';

/**
 * Validate deposit request body.
 */
function validateDeposit(req, res, next) {
  const { account_id, amount } = req.body;
  const errors = [];

  if (!account_id || typeof account_id !== 'string' || !account_id.trim())
    errors.push('account_id is required');
  if (amount === undefined || amount === null)
    errors.push('amount is required');
  else if (typeof amount !== 'number' || isNaN(amount))
    errors.push('amount must be a number');
  else if (amount <= 0)
    errors.push('amount must be greater than 0');
  else if (amount > 10_000_000)
    errors.push('amount exceeds maximum allowed per transaction (₹1,00,00,000)');

  if (errors.length) return res.status(400).json({ success: false, errors });
  next();
}

/**
 * Validate withdrawal request body.
 */
function validateWithdraw(req, res, next) {
  const { account_id, amount } = req.body;
  const errors = [];

  if (!account_id || typeof account_id !== 'string' || !account_id.trim())
    errors.push('account_id is required');
  if (amount === undefined || amount === null)
    errors.push('amount is required');
  else if (typeof amount !== 'number' || isNaN(amount))
    errors.push('amount must be a number');
  else if (amount <= 0)
    errors.push('amount must be greater than 0');

  if (errors.length) return res.status(400).json({ success: false, errors });
  next();
}

/**
 * Validate transfer request body.
 */
function validateTransfer(req, res, next) {
  const { from_account_id, to_account_id, amount, idempotency_key } = req.body;
  const errors = [];

  if (!from_account_id || typeof from_account_id !== 'string' || !from_account_id.trim())
    errors.push('from_account_id is required');
  if (!to_account_id || typeof to_account_id !== 'string' || !to_account_id.trim())
    errors.push('to_account_id is required');
  if (!idempotency_key || typeof idempotency_key !== 'string' || !idempotency_key.trim())
    errors.push('idempotency_key is required for /transfer');
  if (idempotency_key && idempotency_key.length > 255)
    errors.push('idempotency_key must be <= 255 characters');
  if (amount === undefined || amount === null)
    errors.push('amount is required');
  else if (typeof amount !== 'number' || isNaN(amount))
    errors.push('amount must be a number');
  else if (amount <= 0)
    errors.push('amount must be greater than 0');
  else if (amount > 10_000_000)
    errors.push('amount exceeds maximum allowed per transaction (₹1,00,00,000)');

  if (errors.length) return res.status(400).json({ success: false, errors });
  next();
}

module.exports = { validateDeposit, validateWithdraw, validateTransfer };
