const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || './data/transactions.db';

// Ensure data directory exists
const dataDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}

function initializeDatabase() {
  const database = getDb();

  // Transactions table
  database.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id    TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL,
      transaction_type  TEXT NOT NULL CHECK(transaction_type IN ('DEPOSIT','WITHDRAWAL','TRANSFER_DEBIT','TRANSFER_CREDIT')),
      amount            REAL NOT NULL CHECK(amount > 0),
      currency          TEXT NOT NULL DEFAULT 'INR',
      counterparty_account_id TEXT,
      reference         TEXT,
      merchant          TEXT,
      channel           TEXT DEFAULT 'ONLINE' CHECK(channel IN ('ATM','ONLINE','BRANCH','MOBILE')),
      status            TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SUCCESS','FAILED','REVERSED')),
      balance_after     REAL,
      description       TEXT,
      correlation_id    TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Idempotency keys table (for /transfer operations)
  database.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key   TEXT PRIMARY KEY,
      transaction_id    TEXT NOT NULL,
      request_hash      TEXT,
      response_body     TEXT,
      status_code       INTEGER,
      expires_at        DATETIME NOT NULL,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Daily transfer tracking (for limit enforcement)
  database.exec(`
    CREATE TABLE IF NOT EXISTS daily_transfer_totals (
      account_id  TEXT NOT NULL,
      date        TEXT NOT NULL,
      total       REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, date)
    )
  `);

  // Account snapshot (replicated read model - loose coupling)
  database.exec(`
    CREATE TABLE IF NOT EXISTS account_cache (
      account_id    TEXT PRIMARY KEY,
      customer_id   TEXT NOT NULL,
      account_number TEXT,
      account_type  TEXT,
      status        TEXT,
      currency      TEXT DEFAULT 'INR',
      cached_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Indexes for performance
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_txn_account_id ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_txn_created_at ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_idem_key ON idempotency_keys(idempotency_key);
  `);

  logger.info('Database initialized successfully', { db: DB_PATH });
  return database;
}

module.exports = { getDb, initializeDatabase };
