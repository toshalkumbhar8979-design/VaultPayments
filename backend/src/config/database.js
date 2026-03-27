'use strict';

/**
 * NexusPay — SQLite Database Layer
 * Uses sqlite3 + sqlite (async, production-ready)
 */

const path = require('path');
const fs   = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const logger = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || './data/nexuspay.db';

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
  upi_id                TEXT DEFAULT '',
  upi_verified          INTEGER DEFAULT 0,
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
  status            TEXT DEFAULT 'created' CHECK(status IN ('created','processing','authorized','captured','failed','refunded','expired','cancelled','declined')),
  customer_name     TEXT DEFAULT '',
  customer_email    TEXT DEFAULT '',
  customer_phone    TEXT DEFAULT '',
  description       TEXT DEFAULT '',
  qr_code           TEXT DEFAULT '',
  payment_method    TEXT DEFAULT 'qr',
  connector_name    TEXT DEFAULT '',
  connector_ref     TEXT DEFAULT '',
  card_token        TEXT DEFAULT '',
  card_brand        TEXT DEFAULT '',
  card_last4        TEXT DEFAULT '',
  gateway_fee       INTEGER DEFAULT 0,
  net_amount        INTEGER DEFAULT 0,
  metadata          TEXT DEFAULT '{}',
  callback_url      TEXT DEFAULT '',
  redirect_url      TEXT DEFAULT '',
  sms_ack_txn_id    TEXT DEFAULT '',
  decline_code      TEXT DEFAULT '',
  retry_count       INTEGER DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS connector_metrics (
  id              TEXT PRIMARY KEY,
  connector_name  TEXT NOT NULL,
  merchant_id     TEXT DEFAULT '',
  total_attempts  INTEGER DEFAULT 0,
  successes       INTEGER DEFAULT 0,
  failures        INTEGER DEFAULT 0,
  avg_latency_ms  REAL DEFAULT 0,
  success_rate    REAL DEFAULT 0,
  last_used_at    TEXT,
  period          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cm_connector ON connector_metrics(connector_name);

CREATE TABLE IF NOT EXISTS routing_rules (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  name            TEXT NOT NULL,
  priority        INTEGER DEFAULT 0,
  conditions      TEXT DEFAULT '{}',
  connector_name  TEXT NOT NULL,
  is_active       INTEGER DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rr_merchant ON routing_rules(merchant_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT DEFAULT '',
  user_id         TEXT DEFAULT '',
  action          TEXT NOT NULL,
  resource        TEXT NOT NULL,
  resource_id     TEXT DEFAULT '',
  details         TEXT DEFAULT '{}',
  ip_address      TEXT DEFAULT '',
  user_agent      TEXT DEFAULT '',
  result          TEXT DEFAULT 'success',
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_merchant ON audit_logs(merchant_id);
CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_logs(action);

CREATE TABLE IF NOT EXISTS billing_plans (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  name            TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  currency        TEXT DEFAULT 'USD',
  interval        TEXT DEFAULT 'MONTH',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES billing_plans(id),
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  customer_email  TEXT NOT NULL,
  status          TEXT DEFAULT 'active' CHECK(status IN ('active','past_due','canceled')),
  next_billing_date TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  amount          INTEGER NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
  created_at      TEXT NOT NULL
);
`;

// ─── Init ───────────────────────────────────────────────────────────────────

async function initDb() {
  db = await open({
    filename: path.resolve(DB_PATH),
    driver: sqlite3.Database
  });

  // Run schema
  await db.exec(SCHEMA);

  try { await db.exec("ALTER TABLE merchants ADD COLUMN upi_id TEXT DEFAULT ''"); } catch(_) {}
  try { await db.exec("ALTER TABLE merchants ADD COLUMN upi_verified INTEGER DEFAULT 0"); } catch(_) {}

  logger.info(`✅ SQLite database ready at ${path.resolve(DB_PATH)}`);
  return db;
}

// ─── Query Helpers ─────────────────────────────────────────────────────────

function mapParams(data) {
  const result = {};
  for (const [k, v] of Object.entries(data)) {
    result[':' + k] = v;
  }
  return result;
}

// ─── Merchant ───────────────────────────────────────────────────────────────

const merchants = {
  async create(data) {
    await getDb().run(`
      INSERT INTO merchants
        (id,name,email,phone,password_hash,business_name,business_type,website,country,gst_number,
         brand_color,logo_url,webhook_url,api_key_live_hash,api_key_live_prefix,api_key_test_hash,api_key_test_prefix,
         webhook_secret,upi_id,upi_verified,status,kyc_verified,created_at,updated_at)
      VALUES
        (:id,:name,:email,:phone,:password_hash,:business_name,:business_type,:website,:country,:gst_number,
         :brand_color,:logo_url,:webhook_url,:api_key_live_hash,:api_key_live_prefix,:api_key_test_hash,:api_key_test_prefix,
         :webhook_secret,:upi_id,:upi_verified,:status,:kyc_verified,:created_at,:updated_at)
    `, mapParams(data));
    return this.findById(data.id);
  },

  async findById(id) {
    return (await getDb().get('SELECT * FROM merchants WHERE id = ?', [id])) || null;
  },

  async findByEmail(email) {
    return (await getDb().get('SELECT * FROM merchants WHERE email = ?', [email.toLowerCase()])) || null;
  },

  async findByKeyPrefix(prefix) {
    return (await getDb().get('SELECT * FROM merchants WHERE api_key_live_prefix = ? OR api_key_test_prefix = ?', [prefix, prefix])) || null;
  },

  async update(id, data) {
    data.updated_at = new Date().toISOString();
    const fields = Object.keys(data).map(k => `${k} = :${k}`).join(', ');
    await getDb().run(`UPDATE merchants SET ${fields} WHERE id = :id`, mapParams({ ...data, id }));
    return this.findById(id);
  },

  async list(limit = 200) {
    return await getDb().all('SELECT id,name,email,business_name,status,created_at FROM merchants LIMIT ?', [limit]);
  },
};

// ─── Payments ───────────────────────────────────────────────────────────────

const payments = {
  async create(data) {
    if (typeof data.metadata === 'object') data.metadata = JSON.stringify(data.metadata);
    await getDb().run(`
      INSERT INTO payments
        (id,merchant_id,order_id,amount,currency,status,customer_name,customer_email,customer_phone,
         description,qr_code,payment_method,connector_name,connector_ref,card_token,card_brand,card_last4,
         gateway_fee,net_amount,metadata,callback_url,redirect_url,decline_code,retry_count,
         created_at,updated_at,expires_at)
      VALUES
        (:id,:merchant_id,:order_id,:amount,:currency,:status,:customer_name,:customer_email,:customer_phone,
         :description,:qr_code,:payment_method,:connector_name,:connector_ref,:card_token,:card_brand,:card_last4,
         :gateway_fee,:net_amount,:metadata,:callback_url,:redirect_url,:decline_code,:retry_count,
         :created_at,:updated_at,:expires_at)
    `, mapParams(data));
    return this.findById(data.id);
  },

  async findById(id) {
    const row = await getDb().get('SELECT * FROM payments WHERE id = ?', [id]);
    return row ? { ...row, metadata: safeJsonParse(row.metadata, {}) } : null;
  },

  async findByOrderId(orderId, merchantId) {
    return (await getDb().get('SELECT * FROM payments WHERE order_id = ? AND merchant_id = ?', [orderId, merchantId])) || null;
  },

  async update(id, data) {
    data.updated_at = new Date().toISOString();
    if (data.metadata && typeof data.metadata === 'object') data.metadata = JSON.stringify(data.metadata);
    const fields = Object.keys(data).map(k => `${k} = :${k}`).join(', ');
    await getDb().run(`UPDATE payments SET ${fields} WHERE id = :id`, mapParams({ ...data, id }));
    return this.findById(id);
  },

  async listByMerchant(merchantId, limit = 100) {
    return await getDb().all(
      'SELECT id,order_id,amount,currency,status,customer_name,customer_email,created_at FROM payments WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?',
      [merchantId, limit]
    );
  },

  async stats(merchantId) {
    return await getDb().get(`
      SELECT
        COUNT(*) as total_payments,
        SUM(CASE WHEN status='captured' THEN 1 ELSE 0 END) as captured,
        SUM(CASE WHEN status IN ('created','processing') THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status='captured' THEN amount ELSE 0 END) as total_volume
      FROM payments WHERE merchant_id = ?
    `, [merchantId]);
  },
};

// ─── Transactions ────────────────────────────────────────────────────────────

const transactions = {
  async create(data) {
    await getDb().run(`
      INSERT INTO transactions (id,payment_id,merchant_id,type,amount,fee,net_amount,gateway_ref,status,created_at)
      VALUES (:id,:payment_id,:merchant_id,:type,:amount,:fee,:net_amount,:gateway_ref,:status,:created_at)
    `, mapParams(data));
    return data;
  },
  async listByMerchant(merchantId, limit = 100) {
    return await getDb().all('SELECT * FROM transactions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?', [merchantId, limit]);
  },
  async totalFees(merchantId) {
    const r = await getDb().get('SELECT SUM(fee) as total FROM transactions WHERE merchant_id = ?', [merchantId]);
    return r?.total || 0;
  },
};

// ─── SMS Logs ────────────────────────────────────────────────────────────────

const smsLogs = {
  async create(data) {
    await getDb().run(`
      INSERT INTO sms_logs (id,merchant_id,sender,sms_text,parsed_amount,parsed_txn_id,parsed_bank,matched_payment_id,action_taken,created_at)
      VALUES (:id,:merchant_id,:sender,:sms_text,:parsed_amount,:parsed_txn_id,:parsed_bank,:matched_payment_id,:action_taken,:created_at)
    `, mapParams(data));
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeJsonParse(str, fallback = {}) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = { initDb, getDb, merchants, payments, transactions, smsLogs };
