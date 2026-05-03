'use strict';

const express = require('express');
const router  = express.Router();
const txnSvc  = require('../services/transactionService');
const { validateDeposit, validateWithdraw, validateTransfer } = require('../middleware/validate');

// ── List transactions ─────────────────────────────────────────────────────────
/**
 * @openapi
 * /v1/transactions:
 *   get:
 *     summary: List all transactions (paginated)
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [DEPOSIT,WITHDRAWAL,TRANSFER_IN,TRANSFER_OUT,PAYMENT] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [SUCCESS,FAILED,PENDING,ROLLED_BACK] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Paginated transaction list
 */
router.get('/', (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
    const offset = parseInt(req.query.offset || '0', 10);
    const result = txnSvc.listTransactions({
      type: req.query.type, status: req.query.status,
      from: req.query.from, to: req.query.to,
      limit, offset,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ── Account statement ─────────────────────────────────────────────────────────
/**
 * @openapi
 * /v1/transactions/account/{accountId}/statement:
 *   get:
 *     summary: Account statement
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Account statement
 */
router.get('/account/:accountId/statement', (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    const result = txnSvc.getStatement({
      accountId: req.params.accountId,
      type:      req.query.type,
      from:      req.query.from,
      to:        req.query.to,
      limit, offset,
    });
    res.json({ account_id: req.params.accountId, ...result });
  } catch (err) { next(err); }
});

// ── Get single transaction ───────────────────────────────────────────────────
/**
 * @openapi
 * /v1/transactions/{id}:
 *   get:
 *     summary: Get transaction by ID
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transaction record
 *       404:
 *         description: Not found
 */
router.get('/:id', (req, res, next) => {
  try {
    const txn = txnSvc.getTransaction(req.params.id);
    if (!txn) return res.status(404).json({ success: false, error: 'Transaction not found' });
    res.json({ transaction: txn });
  } catch (err) { next(err); }
});

// ── Deposit ───────────────────────────────────────────────────────────────────
/**
 * @openapi
 * /v1/transactions/deposit:
 *   post:
 *     summary: Deposit funds
 *     tags: [Transactions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [account_id, amount]
 *             properties:
 *               account_id: { type: string }
 *               amount:     { type: number, minimum: 0.01 }
 *               channel:    { type: string, enum: [ONLINE,ATM,BRANCH,UPI,NEFT,RTGS] }
 *               description: { type: string }
 *               reference:  { type: string }
 *     responses:
 *       201:
 *         description: Deposit successful
 *       400:
 *         description: Validation error
 *       403:
 *         description: KYC not verified
 *       422:
 *         description: Account frozen/closed
 */
router.post('/deposit', validateDeposit, async (req, res, next) => {
  try {
    const txn = await txnSvc.deposit({
      accountId:   req.body.account_id,
      amount:      req.body.amount,
      channel:     req.body.channel || 'ONLINE',
      description: req.body.description,
      reference:   req.body.reference,
      correlationId: req.correlationId,
    });
    res.status(201).json({ success: true, transaction: txn });
  } catch (err) { next(err); }
});

// ── Withdraw ──────────────────────────────────────────────────────────────────
/**
 * @openapi
 * /v1/transactions/withdraw:
 *   post:
 *     summary: Withdraw funds
 *     tags: [Transactions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [account_id, amount]
 *             properties:
 *               account_id: { type: string }
 *               amount:     { type: number, minimum: 0.01 }
 *               channel:    { type: string }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Withdrawal successful
 *       422:
 *         description: Insufficient balance / account frozen
 */
router.post('/withdraw', validateWithdraw, async (req, res, next) => {
  try {
    const txn = await txnSvc.withdraw({
      accountId:    req.body.account_id,
      amount:       req.body.amount,
      channel:      req.body.channel || 'ATM',
      description:  req.body.description,
      correlationId: req.correlationId,
    });
    res.status(201).json({ success: true, transaction: txn });
  } catch (err) { next(err); }
});

// ── Transfer ──────────────────────────────────────────────────────────────────
/**
 * @openapi
 * /v1/transactions/transfer:
 *   post:
 *     summary: Transfer funds between accounts (idempotent)
 *     tags: [Transactions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [from_account_id, to_account_id, amount, idempotency_key]
 *             properties:
 *               from_account_id: { type: string }
 *               to_account_id:   { type: string }
 *               amount:          { type: number, minimum: 0.01 }
 *               idempotency_key: { type: string, maxLength: 255 }
 *               description:     { type: string }
 *               channel:         { type: string }
 *     responses:
 *       201:
 *         description: Transfer completed (new)
 *       200:
 *         description: Idempotent replay — previous result returned
 *       400:
 *         description: Validation error / same-account transfer
 *       403:
 *         description: KYC not verified
 *       409:
 *         description: Idempotency key conflict
 *       422:
 *         description: Insufficient balance / daily limit / account frozen
 */
router.post('/transfer', validateTransfer, async (req, res, next) => {
  try {
    const result = await txnSvc.transfer({
      fromAccountId:  req.body.from_account_id,
      toAccountId:    req.body.to_account_id,
      amount:         req.body.amount,
      idempotencyKey: req.body.idempotency_key,
      description:    req.body.description,
      channel:        req.body.channel || 'ONLINE',
      correlationId:  req.correlationId,
    });

    const status = result.replay ? 200 : 201;
    res.status(status).json(result);
  } catch (err) { next(err); }
});

module.exports = router;
