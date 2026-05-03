'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

let db;

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function initDb() {
  const dbPath = process.env.DB_PATH || './data/transactions.db';
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);

  // Performance + safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -16000'); // 16 MB
  db.pragma('temp_store = MEMORY');

  createSchema();
  logger.info({ event: 'db_initialized', path: dbPath }, 'Database initialized');
  return db;
}

function createSchema() {
  db.exec(`
    -- ────────────────────────────────────────────────
    -- account_cache: replicated read-model from Account & Customer Service
    -- Stores only fields needed for transaction validation (loose coupling)
    -- ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS account_cache (
      account_id      TEXT PRIMARY KEY,
      customer_id     TEXT NOT NULL,
      customer_name   TEXT,
      account_number  TEXT,
      account_type    TEXT NOT NULL CHECK(account_type IN ('SAVINGS','CURRENT','SALARY','NRE')),
      balance         REAL NOT NULL DEFAULT 0,
      currency        TEXT NOT NULL DEFAULT 'INR',
      status          TEXT NOT NULL CHECK(status IN ('ACTIVE','FROZEN','CLOSED')),
      kyc_status      TEXT NOT NULL DEFAULT 'PENDING' CHECK(kyc_status IN ('VERIFIED','PENDING','REJECTED')),
      cached_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ────────────────────────────────────────────────
    -- transactions: core ledger
    -- ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id    TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL,
      transaction_type  TEXT NOT NULL CHECK(transaction_type IN (
                            'DEPOSIT','WITHDRAWAL','TRANSFER_IN','TRANSFER_OUT','PAYMENT')),
      amount            REAL NOT NULL CHECK(amount > 0),
      currency          TEXT NOT NULL DEFAULT 'INR',
      counterparty_id   TEXT,           -- linked account for transfers
      reference         TEXT,           -- idempotency_key or external ref
      description       TEXT,
      channel           TEXT CHECK(channel IN ('ONLINE','ATM','BRANCH','UPI','NEFT','RTGS')),
      status            TEXT NOT NULL DEFAULT 'SUCCESS'
                            CHECK(status IN ('PENDING','SUCCESS','FAILED','ROLLED_BACK')),
      balance_after     REAL,
      correlation_id    TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_txn_account_id   ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_txn_created_at   ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_txn_type         ON transactions(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_txn_status       ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_txn_reference    ON transactions(reference);

    -- ────────────────────────────────────────────────
    -- idempotency_keys: for /transfer deduplication
    -- ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key   TEXT PRIMARY KEY,
      request_hash      TEXT NOT NULL,
      response_body     TEXT NOT NULL,        -- JSON-serialised full response
      http_status       INTEGER NOT NULL,
      debit_txn_id      TEXT,
      credit_txn_id     TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at        TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))
    );

    CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at);

    -- ────────────────────────────────────────────────
    -- daily_transfer_totals: rolling daily cap enforcement
    -- ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS daily_transfer_totals (
      account_id    TEXT NOT NULL,
      transfer_date TEXT NOT NULL,           -- YYYY-MM-DD UTC
      total_amount  REAL NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id, transfer_date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_transfer_totals(transfer_date);
  `);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

module.exports = { initDb, getDb, closeDb };
