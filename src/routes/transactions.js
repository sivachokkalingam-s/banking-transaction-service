const router = require('express').Router();
const transactionService = require('../services/transactionService');
const { validateDeposit, validateWithdrawal, validateTransfer } = require('../middleware/validation');
const logger = require('../utils/logger');

// ── GET /v1/transactions ──────────────────────────────────────────────────────

/**
 * @openapi
 * /v1/transactions:
 *   get:
 *     summary: List all transactions
 *     description: Returns paginated list of transactions with optional filters
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, SUCCESS, FAILED, REVERSED]
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [DEPOSIT, WITHDRAWAL, TRANSFER_DEBIT, TRANSFER_CREDIT]
 *       - in: query
 *         name: account_id
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: List of transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 total:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 transactions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Transaction'
 */
router.get('/', (req, res, next) => {
  try {
    const result = transactionService.getAllTransactions(req.query);
    return res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── GET /v1/transactions/:id ──────────────────────────────────────────────────

/**
 * @openapi
 * /v1/transactions/{transactionId}:
 *   get:
 *     summary: Get transaction by ID
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: transactionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transaction details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transaction:
 *                   $ref: '#/components/schemas/Transaction'
 *       404:
 *         $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:transactionId', (req, res, next) => {
  try {
    const txn = transactionService.getTransaction(req.params.transactionId);
    return res.json({ success: true, transaction: txn });
  } catch (err) {
    next(err);
  }
});

// ── GET /v1/transactions/account/:accountId/statement ────────────────────────

/**
 * @openapi
 * /v1/transactions/account/{accountId}/statement:
 *   get:
 *     summary: Get account statement
 *     description: Returns transaction history for a specific account (account mini-statement)
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema:
 *           type: string
 *         example: ACC001
 *       - in: query
 *         name: from
 *         description: Start date (YYYY-MM-DD)
 *         schema:
 *           type: string
 *       - in: query
 *         name: to
 *         description: End date (YYYY-MM-DD)
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [DEPOSIT, WITHDRAWAL, TRANSFER_DEBIT, TRANSFER_CREDIT]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Account statement
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 account_id:
 *                   type: string
 *                 total:
 *                   type: integer
 *                 transactions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Transaction'
 */
router.get('/account/:accountId/statement', (req, res, next) => {
  try {
    const result = transactionService.getStatement(req.params.accountId, req.query);
    return res.json({ success: true, account_id: req.params.accountId, ...result });
  } catch (err) {
    next(err);
  }
});

// ── POST /v1/transactions/deposit ────────────────────────────────────────────

/**
 * @openapi
 * /v1/transactions/deposit:
 *   post:
 *     summary: Process a deposit
 *     description: Credit funds to an account. Calls Account Service to update balance.
 *     tags: [Transactions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DepositRequest'
 *           example:
 *             account_id: "ACC001"
 *             amount: 5000
 *             channel: "ONLINE"
 *             description: "Salary credit"
 *             reference: "SAL-JAN-2024"
 *     responses:
 *       201:
 *         description: Deposit successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transaction:
 *                   $ref: '#/components/schemas/Transaction'
 *       400:
 *         description: Validation error
 *       422:
 *         description: Business rule violation (frozen account, etc.)
 *       502:
 *         description: Account service unavailable
 */
router.post('/deposit', validateDeposit, async (req, res, next) => {
  try {
    const txn = await transactionService.processDeposit({
      ...req.body,
      amount: Number(req.body.amount),
      correlation_id: req.correlationId,
    });
    return res.status(201).json({ success: true, transaction: txn });
  } catch (err) {
    next(err);
  }
});

// ── POST /v1/transactions/withdraw ───────────────────────────────────────────

/**
 * @openapi
 * /v1/transactions/withdraw:
 *   post:
 *     summary: Process a withdrawal
 *     description: Debit funds from an account. Prevents overdraft on SAVINGS accounts.
 *     tags: [Transactions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WithdrawalRequest'
 *           example:
 *             account_id: "ACC001"
 *             amount: 2000
 *             channel: "ATM"
 *     responses:
 *       201:
 *         description: Withdrawal successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transaction:
 *                   $ref: '#/components/schemas/Transaction'
 *       400:
 *         description: Validation error
 *       422:
 *         description: Insufficient funds or frozen account
 */
router.post('/withdraw', validateWithdrawal, async (req, res, next) => {
  try {
    const txn = await transactionService.processWithdrawal({
      ...req.body,
      amount: Number(req.body.amount),
      correlation_id: req.correlationId,
    });
    return res.status(201).json({ success: true, transaction: txn });
  } catch (err) {
    next(err);
  }
});

// ── POST /v1/transactions/transfer ───────────────────────────────────────────

/**
 * @openapi
 * /v1/transactions/transfer:
 *   post:
 *     summary: Transfer funds between accounts (idempotent)
 *     description: |
 *       Atomically moves funds from one account to another.
 *       - Creates both TRANSFER_DEBIT and TRANSFER_CREDIT records
 *       - Enforces ₹2,00,000 daily limit per source account
 *       - Prevents overdraft on SAVINGS accounts
 *       - Blocks frozen accounts
 *       - Idempotency: repeat calls with same `idempotency_key` return cached result
 *       - Full rollback if credit fails after debit succeeds
 *       - Fires high-value notification if amount ≥ ₹50,000
 *     tags: [Transactions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TransferRequest'
 *           example:
 *             from_account_id: "ACC001"
 *             to_account_id: "ACC002"
 *             amount: 10000
 *             idempotency_key: "transfer-unique-key-2024-001"
 *             description: "Rent payment"
 *             channel: "ONLINE"
 *     responses:
 *       201:
 *         description: Transfer successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TransferResponse'
 *       200:
 *         description: Idempotent replay – previous successful response returned
 *       400:
 *         description: Validation error (missing fields, same account, etc.)
 *       422:
 *         description: Business rule violation (daily limit, insufficient funds, frozen)
 *       502:
 *         description: Account service error
 */
router.post('/transfer', validateTransfer, async (req, res, next) => {
  try {
    const result = await transactionService.processTransfer({
      ...req.body,
      amount: Number(req.body.amount),
      correlation_id: req.correlationId,
    });
    const statusCode = result.replay ? 200 : 201;
    return res.status(statusCode).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
