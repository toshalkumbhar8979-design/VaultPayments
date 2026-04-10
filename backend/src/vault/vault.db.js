'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const logger = require('../utils/logger');

const VAULT_DB_PATH = process.env.VAULT_DB_PATH || './data/vault.db';

const vaultDir = path.dirname(path.resolve(VAULT_DB_PATH));
if (!fs.existsSync(vaultDir)) fs.mkdirSync(vaultDir, { recursive: true });

let vaultDb;

function getVaultDb() {
  if (!vaultDb) throw new Error('Vault DB not initialized. Call initVaultDb() first.');
  return vaultDb;
}

const VAULT_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS vault_tokens (
  token         TEXT PRIMARY KEY,
  encrypted     TEXT NOT NULL,
  brand         TEXT DEFAULT 'unknown',
  last4         TEXT NOT NULL,
  masked        TEXT NOT NULL,
  expiryMonth   TEXT NOT NULL,
  expiryYear    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_created ON vault_tokens(created_at);

CREATE TABLE IF NOT EXISTS merchant_credentials (
  merchant_id           TEXT NOT NULL,
  connector_name        TEXT NOT NULL,
  credentials_encrypted TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (merchant_id, connector_name)
);
`;

async function initVaultDb() {
  vaultDb = await open({
    filename: path.resolve(VAULT_DB_PATH),
    driver: sqlite3.Database
  });

  await vaultDb.exec(VAULT_SCHEMA);
  logger.info(`🔐 Secure Vault SQLite database ready at ${path.resolve(VAULT_DB_PATH)}`);
  return vaultDb;
}

const tokens = {
  async insert(data) {
    await getVaultDb().run(`
      INSERT INTO vault_tokens (token, encrypted, brand, last4, masked, expiryMonth, expiryYear, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.token, data.encrypted, data.brand, data.last4,
      data.masked, data.expiryMonth, data.expiryYear, data.createdAt
    ]);
  },

  async find(token) {
    return await getVaultDb().get('SELECT * FROM vault_tokens WHERE token = ?', [token]);
  },

  async delete(token) {
    const result = await getVaultDb().run('DELETE FROM vault_tokens WHERE token = ?', [token]);
    return result.changes > 0;
  }
};

const merchant_credentials = {
  async upsert(data) {
    await getVaultDb().run(`
      INSERT OR REPLACE INTO merchant_credentials (merchant_id, connector_name, credentials_encrypted, updated_at)
      VALUES (?, ?, ?, ?)
    `, [data.merchant_id, data.connector_name, data.credentials_encrypted, data.updated_at]);
  },

  async find(merchantId, connectorName) {
    return await getVaultDb().get(
      'SELECT * FROM merchant_credentials WHERE merchant_id = ? AND connector_name = ?',
      [merchantId, connectorName]
    );
  }
};

module.exports = { initVaultDb, getVaultDb, tokens, merchant_credentials };
