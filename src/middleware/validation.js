/**
 * Validate deposit request body.
 */
function validateDeposit(req, res, next) {
  const { account_id, amount } = req.body;
  const errors = [];

  if (!account_id || typeof account_id !== 'string') errors.push('account_id is required');
  if (!amount || isNaN(amount) || Number(amount) <= 0) errors.push('amount must be a positive number');
  if (amount && Number(amount) > 10_000_000) errors.push('amount exceeds maximum single-transaction limit');

  const validChannels = ['ATM', 'ONLINE', 'BRANCH', 'MOBILE'];
  if (req.body.channel && !validChannels.includes(req.body.channel)) {
    errors.push(`channel must be one of: ${validChannels.join(', ')}`);
  }

  if (errors.length) {
    return res.status(400).json({ success: false, error: errors.join('; '), code: 'VALIDATION_ERROR' });
  }
  next();
}

/**
 * Validate withdrawal request body.
 */
function validateWithdrawal(req, res, next) {
  const { account_id, amount } = req.body;
  const errors = [];

  if (!account_id || typeof account_id !== 'string') errors.push('account_id is required');
  if (!amount || isNaN(amount) || Number(amount) <= 0) errors.push('amount must be a positive number');

  if (errors.length) {
    return res.status(400).json({ success: false, error: errors.join('; '), code: 'VALIDATION_ERROR' });
  }
  next();
}

/**
 * Validate transfer request body.
 */
function validateTransfer(req, res, next) {
  const { from_account_id, to_account_id, amount, idempotency_key } = req.body;
  const errors = [];

  if (!from_account_id || typeof from_account_id !== 'string') errors.push('from_account_id is required');
  if (!to_account_id || typeof to_account_id !== 'string') errors.push('to_account_id is required');
  if (!amount || isNaN(amount) || Number(amount) <= 0) errors.push('amount must be a positive number');
  if (!idempotency_key || typeof idempotency_key !== 'string') errors.push('idempotency_key is required');
  if (idempotency_key && idempotency_key.length > 200) errors.push('idempotency_key too long (max 200 chars)');
  if (from_account_id && to_account_id && from_account_id === to_account_id) {
    errors.push('from_account_id and to_account_id must be different');
  }

  if (errors.length) {
    return res.status(400).json({ success: false, error: errors.join('; '), code: 'VALIDATION_ERROR' });
  }
  next();
}

module.exports = { validateDeposit, validateWithdrawal, validateTransfer };
