'use strict';

/**
 * NexusPay — PostgreSQL Connection (Ledger Database)
 * 
 * Dedicated connection pool for double-entry ledger operations.
 * Uses node-postgres with SERIALIZABLE isolation for financial safety.
 * 
 * CRITICAL: This database ONLY handles financial data.
 * Non-financial data (merchants, config) stays in SQLite.
 */

const { Pool } = require('pg');
const logger = require('../utils/logger');

// ── Configuration ───────────────────────────────────────────────────────────

const PG_CONFIG = {
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'nexuspay_ledger',
  user:     process.env.PG_USER     || 'nexuspay',
  password: process.env.PG_PASSWORD || 'nexuspay_secure_2026',

  // Connection pool
  min: parseInt(process.env.PG_POOL_MIN || '2'),
  max: parseInt(process.env.PG_POOL_MAX || '20'),

  // Timeouts
  idleTimeoutMillis:       10000,
  connectionTimeoutMillis: 5000,
  statement_timeout:       30000,

  // SSL in production
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }
    : false,
};

let pool = null;

// ── Pool Management ─────────────────────────────────────────────────────────

function getPool() {
  if (!pool) throw new Error('PostgreSQL pool not initialized. Call initPgPool() first.');
  return pool;
}

async function initPgPool() {
  pool = new Pool(PG_CONFIG);

  // Connection error handler
  pool.on('error', (err) => {
    logger.error('[PG] Unexpected pool error:', err.message);
  });

  // Test connectivity
  try {
    const client = await pool.connect();
    const res = await client.query('SELECT NOW() as now, version() as version');
    client.release();

    logger.info(`🐘 PostgreSQL connected: ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}`);
    logger.info(`   Server time: ${res.rows[0].now}`);
    return pool;
  } catch (err) {
    logger.warn(`⚠️  PostgreSQL not available (${err.message}). Ledger will use in-memory fallback.`);
    // In development/sandbox, we allow startup without PG
    // The ledger service will check pool health before operations
    return null;
  }
}

// ── Transaction Helpers ─────────────────────────────────────────────────────

/**
 * Execute a callback within a SERIALIZABLE transaction.
 * This is the safest isolation level for financial operations —
 * it prevents phantom reads and ensures linearizability.
 * 
 * @param {Function} fn - async (client) => result
 * @returns {*} Result of the callback
 * @throws Will rollback and rethrow on any error
 */
async function withTransaction(fn, isolationLevel = 'SERIALIZABLE') {
  const client = await getPool().connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Simple query helper (non-transactional).
 */
async function query(text, params = []) {
  return getPool().query(text, params);
}

/**
 * Check if PostgreSQL is available.
 */
function isAvailable() {
  return pool !== null && pool.totalCount > 0;
}

/**
 * Graceful shutdown.
 */
async function closePgPool() {
  if (pool) {
    await pool.end();
    logger.info('[PG] Connection pool closed.');
    pool = null;
  }
}

module.exports = {
  initPgPool,
  getPool,
  withTransaction,
  query,
  isAvailable,
  closePgPool,
};
