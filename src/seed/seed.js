require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { getDb, initializeDatabase } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ── Sample Account IDs (replicated from Account Service) ─────────────────────
const ACCOUNTS = [
  { account_id: 'ACC-001', customer_id: 'CUST-001', account_type: 'SAVINGS', status: 'active' },
  { account_id: 'ACC-002', customer_id: 'CUST-002', account_type: 'CURRENT', status: 'active' },
  { account_id: 'ACC-003', customer_id: 'CUST-003', account_type: 'SAVINGS', status: 'active' },
  { account_id: 'ACC-004', customer_id: 'CUST-004', account_type: 'SAVINGS', status: 'active' },
  { account_id: 'ACC-005', customer_id: 'CUST-005', account_type: 'CURRENT', status: 'active' },
  { account_id: 'ACC-006', customer_id: 'CUST-006', account_type: 'SAVINGS', status: 'frozen' },
  { account_id: 'ACC-007', customer_id: 'CUST-007', account_type: 'SAVINGS', status: 'active' },
  { account_id: 'ACC-008', customer_id: 'CUST-008', account_type: 'CURRENT', status: 'active' },
];

const MERCHANTS = ['Amazon India', 'Flipkart', 'Swiggy', 'Zomato', 'Uber', 'Ola', 'IRCTC', 'BigBasket', 'Myntra', 'BookMyShow'];
const CHANNELS = ['ATM', 'ONLINE', 'BRANCH', 'MOBILE'];
const TXN_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_DEBIT', 'TRANSFER_CREDIT'];
const STATUSES = ['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILED', 'REVERSED']; // weighted

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomAmount(min, max) { return parseFloat((Math.random() * (max - min) + min).toFixed(2)); }
function randomDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(Math.random() * daysAgo));
  return d.toISOString();
}

function seed() {
  initializeDatabase();
  const db = getDb();

  // Create meta table if not exists
  db.exec(`CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)`);

  // Clear existing seed data
  db.prepare('DELETE FROM transactions').run();
  db.prepare('DELETE FROM idempotency_keys').run();
  db.prepare('DELETE FROM daily_transfer_totals').run();
  db.prepare('DELETE FROM account_cache').run();
  db.prepare('DELETE FROM __meta').run();

  // ── Seed account cache (replicated read model) ──────────────────────────
  const insertCache = db.prepare(`
    INSERT OR REPLACE INTO account_cache (account_id, customer_id, account_type, status, currency)
    VALUES (?, ?, ?, ?, 'INR')
  `);
  ACCOUNTS.forEach(a => insertCache.run(a.account_id, a.customer_id, a.account_type, a.status));
  logger.info(`Seeded ${ACCOUNTS.length} account cache entries`);

  // ── Seed 300 transactions ───────────────────────────────────────────────
  const insertTxn = db.prepare(`
    INSERT INTO transactions (
      transaction_id, account_id, transaction_type, amount, currency,
      counterparty_account_id, reference, merchant, channel, status,
      balance_after, description, correlation_id, created_at, updated_at
    ) VALUES (
      @transaction_id, @account_id, @transaction_type, @amount, @currency,
      @counterparty_account_id, @reference, @merchant, @channel, @status,
      @balance_after, @description, @correlation_id, @created_at, @created_at
    )
  `);

  const seedMany = db.transaction((txns) => {
    for (const t of txns) insertTxn.run(t);
  });

  const transactions = [];
  let balance = 50000; // running balance simulation

  for (let i = 1; i <= 300; i++) {
    const account = randomFrom(ACCOUNTS.filter(a => a.status === 'active'));
    const type = randomFrom(TXN_TYPES);
    const amount = type === 'DEPOSIT'
      ? randomAmount(500, 100000)
      : type === 'WITHDRAWAL'
        ? randomAmount(200, 20000)
        : randomAmount(1000, 50000);

    const isTransfer = type === 'TRANSFER_DEBIT' || type === 'TRANSFER_CREDIT';
    const counterparty = isTransfer ? randomFrom(ACCOUNTS.filter(a => a.account_id !== account.account_id)).account_id : null;

    balance = Math.max(balance + (type === 'DEPOSIT' || type === 'TRANSFER_CREDIT' ? amount : -amount), 1000);

    transactions.push({
      transaction_id: `TXN-SEED-${String(i).padStart(4, '0')}`,
      account_id: account.account_id,
      transaction_type: type,
      amount,
      currency: 'INR',
      counterparty_account_id: counterparty,
      reference: `REF-${uuidv4().slice(0, 8).toUpperCase()}`,
      merchant: type === 'WITHDRAWAL' ? randomFrom(MERCHANTS) : null,
      channel: randomFrom(CHANNELS),
      status: randomFrom(STATUSES),
      balance_after: parseFloat(balance.toFixed(2)),
      description: `Seeded ${type.toLowerCase().replace('_', ' ')} #${i}`,
      correlation_id: uuidv4(),
      created_at: randomDate(90),
    });
  }

  seedMany(transactions);
  logger.info(`Seeded ${transactions.length} transactions`);

  // ── Seed a few idempotency keys ─────────────────────────────────────────
  const insertIdem = db.prepare(`
    INSERT OR REPLACE INTO idempotency_keys (idempotency_key, transaction_id, response_body, status_code, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  insertIdem.run('seed-idem-key-001', 'TXN-SEED-0050', JSON.stringify({ replay: false, message: 'seeded' }), 201, expiresAt);

  // ── Meta ────────────────────────────────────────────────────────────────
  db.prepare("INSERT OR REPLACE INTO __meta VALUES ('seedVersion', '1')").run();
  db.prepare("INSERT OR REPLACE INTO __meta VALUES ('seededAt', ?)").run(new Date().toISOString());

  logger.info('Seed completed successfully');
}

seed();
