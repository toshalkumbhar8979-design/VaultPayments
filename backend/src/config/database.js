'use strict';

/**
 * VaultPay — SQLite Database Layer
 * Uses better-sqlite3 (synchronous, zero-config, production-ready)
 * For high-traffic production: swap to PostgreSQL via pg/Drizzle
 */

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');
const logger = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || './data/vaultpay.db';

// Ensure data directory exists
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db;

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// ─── Schema ────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS merchants (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  email                 TEXT UNIQUE NOT NULL,
  phone                 TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  business_name         TEXT NOT NULL,
  business_type         TEXT DEFAULT 'other',
  website               TEXT DEFAULT '',
  country               TEXT DEFAULT 'IN',
  gst_number            TEXT DEFAULT '',
  brand_color           TEXT DEFAULT '#5b4fff',
  logo_url              TEXT DEFAULT '',
  webhook_url           TEXT DEFAULT '',
  api_key_live_hash     TEXT NOT NULL,
  api_key_live_prefix   TEXT NOT NULL,
  api_key_test_hash     TEXT NOT NULL,
  api_key_test_prefix   TEXT NOT NULL,
  webhook_secret        TEXT NOT NULL,
  status                TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','pending')),
  kyc_verified          INTEGER DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchants_email  ON merchants(email);
CREATE INDEX IF NOT EXISTS idx_merchants_prefix ON merchants(api_key_live_prefix, api_key_test_prefix);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  order_id          TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  currency          TEXT DEFAULT 'INR',
  status            TEXT DEFAULT 'created' CHECK(status IN ('created','processing','captured','failed','refunded','expired','cancelled')),
  customer_name     TEXT DEFAULT '',
  customer_email    TEXT DEFAULT '',
  customer_phone    TEXT DEFAULT '',
  description       TEXT DEFAULT '',
  qr_code           TEXT DEFAULT '',
  payment_method    TEXT DEFAULT 'qr',
  gateway_fee       INTEGER DEFAULT 0,
  net_amount        INTEGER DEFAULT 0,
  metadata          TEXT DEFAULT '{}',
  callback_url      TEXT DEFAULT '',
  redirect_url      TEXT DEFAULT '',
  sms_ack_txn_id    TEXT DEFAULT '',
  captured_at       TEXT,
  refunded_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  UNIQUE(order_id, merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id, merchant_id);

CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  type          TEXT DEFAULT 'credit',
  amount        INTEGER NOT NULL,
  fee           INTEGER DEFAULT 0,
  net_amount    INTEGER DEFAULT 0,
  gateway_ref   TEXT DEFAULT '',
  status        TEXT DEFAULT 'settled',
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txn_merchant ON transactions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_txn_payment  ON transactions(payment_id);

CREATE TABLE IF NOT EXISTS sms_logs (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  sender              TEXT DEFAULT '',
  sms_text            TEXT NOT NULL,
  parsed_amount       REAL,
  parsed_txn_id       TEXT DEFAULT '',
  parsed_bank         TEXT DEFAULT '',
  matched_payment_id  TEXT DEFAULT '',
  action_taken        TEXT DEFAULT '',
  created_at          TEXT NOT NULL
);
`;

// ─── Init ───────────────────────────────────────────────────────────────────

function initDb() {
  db = new Database(path.resolve(DB_PATH), {
    verbose: process.env.NODE_ENV === 'development' ? logger.debug.bind(logger) : undefined,
  });

  // Run schema
  db.exec(SCHEMA);

  logger.info(`✅ SQLite database ready at ${path.resolve(DB_PATH)}`);
  return db;
}

// ─── Merchant ───────────────────────────────────────────────────────────────

const merchants = {
  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO merchants
        (id,name,email,phone,password_hash,business_name,business_type,website,country,gst_number,
         brand_color,logo_url,api_key_live_hash,api_key_live_prefix,api_key_test_hash,api_key_test_prefix,
         webhook_secret,status,kyc_verified,created_at,updated_at)
      VALUES
        (@id,@name,@email,@phone,@password_hash,@business_name,@business_type,@website,@country,@gst_number,
         @brand_color,@logo_url,@api_key_live_hash,@api_key_live_prefix,@api_key_test_hash,@api_key_test_prefix,
         @webhook_secret,@status,@kyc_verified,@created_at,@updated_at)
    `);
    stmt.run(data);
    return this.findById(data.id);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM merchants WHERE id = ?').get(id) || null;
  },

  findByEmail(email) {
    return getDb().prepare('SELECT * FROM merchants WHERE email = ?').get(email.toLowerCase()) || null;
  },

  findByKeyPrefix(prefix) {
    return getDb().prepare('SELECT * FROM merchants WHERE api_key_live_prefix = ? OR api_key_test_prefix = ?').get(prefix, prefix) || null;
  },

  update(id, data) {
    data.updated_at = new Date().toISOString();
    const fields = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
    getDb().prepare(`UPDATE merchants SET ${fields} WHERE id = @id`).run({ ...data, id });
    return this.findById(id);
  },

  list(limit = 200) {
    return getDb().prepare('SELECT id,name,email,business_name,status,created_at FROM merchants LIMIT ?').all(limit);
  },
};

// ─── Payments ───────────────────────────────────────────────────────────────

const payments = {
  create(data) {
    if (typeof data.metadata === 'object') data.metadata = JSON.stringify(data.metadata);
    const stmt = getDb().prepare(`
      INSERT INTO payments
        (id,merchant_id,order_id,amount,currency,status,customer_name,customer_email,customer_phone,
         description,qr_code,payment_method,gateway_fee,net_amount,metadata,callback_url,redirect_url,
         created_at,updated_at,expires_at)
      VALUES
        (@id,@merchant_id,@order_id,@amount,@currency,@status,@customer_name,@customer_email,@customer_phone,
         @description,@qr_code,@payment_method,@gateway_fee,@net_amount,@metadata,@callback_url,@redirect_url,
         @created_at,@updated_at,@expires_at)
    `);
    stmt.run(data);
    return this.findById(data.id);
  },

  findById(id) {
    const row = getDb().prepare('SELECT * FROM payments WHERE id = ?').get(id);
    return row ? { ...row, metadata: safeJsonParse(row.metadata, {}) } : null;
  },

  findByOrderId(orderId, merchantId) {
    return getDb().prepare('SELECT * FROM payments WHERE order_id = ? AND merchant_id = ?').get(orderId, merchantId) || null;
  },

  update(id, data) {
    data.updated_at = new Date().toISOString();
    if (data.metadata && typeof data.metadata === 'object') data.metadata = JSON.stringify(data.metadata);
    const fields = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
    getDb().prepare(`UPDATE payments SET ${fields} WHERE id = @id`).run({ ...data, id });
    return this.findById(id);
  },

  listByMerchant(merchantId, limit = 100) {
    return getDb().prepare(
      'SELECT id,order_id,amount,currency,status,customer_name,customer_email,created_at FROM payments WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(merchantId, limit);
  },

  stats(merchantId) {
    const s = getDb().prepare(`
      SELECT
        COUNT(*) as total_payments,
        SUM(CASE WHEN status='captured' THEN 1 ELSE 0 END) as captured,
        SUM(CASE WHEN status IN ('created','processing') THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status='captured' THEN amount ELSE 0 END) as total_volume
      FROM payments WHERE merchant_id = ?
    `).get(merchantId);
    return s;
  },
};

// ─── Transactions ────────────────────────────────────────────────────────────

const transactions = {
  create(data) {
    getDb().prepare(`
      INSERT INTO transactions (id,payment_id,merchant_id,type,amount,fee,net_amount,gateway_ref,status,created_at)
      VALUES (@id,@payment_id,@merchant_id,@type,@amount,@fee,@net_amount,@gateway_ref,@status,@created_at)
    `).run(data);
    return data;
  },
  listByMerchant(merchantId, limit = 100) {
    return getDb().prepare('SELECT * FROM transactions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?').all(merchantId, limit);
  },
  totalFees(merchantId) {
    const r = getDb().prepare('SELECT SUM(fee) as total FROM transactions WHERE merchant_id = ?').get(merchantId);
    return r?.total || 0;
  },
};

// ─── SMS Logs ────────────────────────────────────────────────────────────────

const smsLogs = {
  create(data) {
    getDb().prepare(`
      INSERT INTO sms_logs (id,merchant_id,sender,sms_text,parsed_amount,parsed_txn_id,parsed_bank,matched_payment_id,action_taken,created_at)
      VALUES (@id,@merchant_id,@sender,@sms_text,@parsed_amount,@parsed_txn_id,@parsed_bank,@matched_payment_id,@action_taken,@created_at)
    `).run(data);
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeJsonParse(str, fallback = {}) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = { initDb, getDb, merchants, payments, transactions, smsLogs };
