'use strict';

/**
 * NexusPay — Double-Entry Ledger Service
 * 
 * ACID-compliant financial ledger using PostgreSQL SERIALIZABLE transactions.
 * Every monetary operation produces balanced DEBIT+CREDIT entry pairs.
 * 
 * INVARIANT: For every transaction_id, SUM(debits) === SUM(credits)
 * 
 * NO RAW CARD DATA (PAN/CVV) IS EVER LOGGED OR STORED BY THIS SERVICE.
 */

const { v4: uuidv4 } = require('uuid');
const { withTransaction, query, isAvailable } = require('../config/pg.database');
const logger = require('../utils/logger');

// ── Account Management ──────────────────────────────────────────────────────

/**
 * Get or create a merchant ledger account.
 * @param {string} merchantId 
 * @param {string} currency 
 * @returns {Object} account row
 */
async function getOrCreateMerchantAccount(merchantId, currency = 'INR') {
  return withTransaction(async (client) => {
    // Try to find existing
    const existing = await client.query(
      `SELECT * FROM ledger_accounts WHERE merchant_id = $1 AND currency = $2 AND account_type = 'merchant'`,
      [merchantId, currency]
    );

    if (existing.rows.length > 0) return existing.rows[0];

    // Create new merchant account
    const result = await client.query(
      `INSERT INTO ledger_accounts (account_type, merchant_id, currency, total_balance, frozen_funds)
       VALUES ('merchant', $1, $2, 0, 0)
       RETURNING *`,
      [merchantId, currency]
    );

    logger.info(`[LEDGER] Created merchant account for ${merchantId} (${currency})`);
    return result.rows[0];
  }, 'READ COMMITTED');
}

/**
 * Get or create a system account (platform_fee, settlement_pool, etc.).
 */
async function getOrCreateSystemAccount(accountType, currency = 'INR') {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM ledger_accounts WHERE account_type = $1 AND currency = $2 AND merchant_id IS NULL`,
      [accountType, currency]
    );

    if (existing.rows.length > 0) return existing.rows[0];

    const result = await client.query(
      `INSERT INTO ledger_accounts (account_type, currency, total_balance, frozen_funds)
       VALUES ($1, $2, 0, 0)
       RETURNING *`,
      [accountType, currency]
    );

    logger.info(`[LEDGER] Created system account: ${accountType} (${currency})`);
    return result.rows[0];
  }, 'READ COMMITTED');
}

/**
 * Get merchant balance summary.
 */
async function getMerchantBalance(merchantId, currency = 'INR') {
  const result = await query(
    `SELECT total_balance, frozen_funds, available_balance, updated_at
     FROM ledger_accounts 
     WHERE merchant_id = $1 AND currency = $2 AND account_type = 'merchant'`,
    [merchantId, currency]
  );

  if (result.rows.length === 0) {
    return { total_balance: 0, frozen_funds: 0, available_balance: 0, exists: false };
  }

  return { ...result.rows[0], exists: true };
}

// ── Core Ledger Operations ──────────────────────────────────────────────────

/**
 * Record a successful payment capture in the ledger.
 * Creates balanced double entries:
 *   DEBIT  customer_source   → gross amount (money coming IN)
 *   CREDIT merchant_account  → net amount (merchant's share)
 *   CREDIT platform_fee      → fee amount (NexusPay's commission)
 * 
 * @param {Object} params
 * @param {string} params.paymentId - Payment reference
 * @param {string} params.merchantId - Merchant ID
 * @param {number} params.grossAmount - Total payment amount (minor units)
 * @param {number} params.feeAmount - Platform fee (minor units)
 * @param {number} params.gstOnFee - GST on platform fee (minor units)
 * @param {string} params.currency - Currency code
 * @param {string} params.idempotencyKey - Idempotency key
 * @returns {Object} { transactionId, entries }
 */
async function recordPaymentCapture({
  paymentId,
  merchantId,
  grossAmount,
  feeAmount,
  gstOnFee = 0,
  currency = 'INR',
  idempotencyKey,
  description = '',
}) {
  if (!isAvailable()) {
    logger.warn('[LEDGER] PostgreSQL unavailable — skipping ledger entry (sandbox mode)');
    return { transactionId: uuidv4(), entries: [], sandbox: true };
  }

  const transactionId = uuidv4();
  const netAmount = grossAmount - feeAmount - gstOnFee;

  return withTransaction(async (client) => {
    // ── Idempotency Check ──
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT * FROM idempotency_keys WHERE key = $1`,
        [idempotencyKey]
      );
      if (existing.rows.length > 0 && existing.rows[0].status === 'completed') {
        logger.info(`[LEDGER] Idempotent replay for key=${idempotencyKey}`);
        return JSON.parse(existing.rows[0].response_body || '{}');
      }
    }

    // ── Ensure accounts exist ──
    const merchantAcct = await ensureAccount(client, 'merchant', merchantId, currency);
    const customerAcct = await ensureAccount(client, 'customer_source', null, currency);
    const feeAcct      = await ensureAccount(client, 'platform_fee', null, currency);

    const entries = [];

    // ── Entry 1: DEBIT customer source (money in) ──
    await adjustBalance(client, customerAcct.id, -grossAmount);
    const entry1 = await insertEntry(client, {
      transactionId,
      paymentId,
      accountId: customerAcct.id,
      entryType: 'DEBIT',
      amount: grossAmount,
      description: `Payment ${paymentId} — customer charge`,
    });
    entries.push(entry1);

    // ── Entry 2: CREDIT merchant account (net amount) ──
    await adjustBalance(client, merchantAcct.id, netAmount);
    const entry2 = await insertEntry(client, {
      transactionId,
      paymentId,
      accountId: merchantAcct.id,
      entryType: 'CREDIT',
      amount: netAmount,
      description: `Payment ${paymentId} — merchant credit (net of fees)`,
    });
    entries.push(entry2);

    // ── Entry 3: CREDIT platform fee account ──
    if (feeAmount > 0) {
      const totalFee = feeAmount + gstOnFee;
      await adjustBalance(client, feeAcct.id, totalFee);
      const entry3 = await insertEntry(client, {
        transactionId,
        paymentId,
        accountId: feeAcct.id,
        entryType: 'CREDIT',
        amount: totalFee,
        description: `Payment ${paymentId} — platform fee (${feeAmount} + GST ${gstOnFee})`,
      });
      entries.push(entry3);
    }

    // ── Verify balance: SUM(debits) === SUM(credits) ──
    const verification = await client.query(
      `SELECT 
        SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END) as total_debits,
        SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END) as total_credits
       FROM ledger_entries WHERE transaction_id = $1`,
      [transactionId]
    );

    const { total_debits, total_credits } = verification.rows[0];
    if (BigInt(total_debits) !== BigInt(total_credits)) {
      throw new Error(`LEDGER INTEGRITY VIOLATION: debits(${total_debits}) !== credits(${total_credits}) for txn ${transactionId}`);
    }

    // ── Store idempotency result ──
    const result = { transactionId, entries, grossAmount, netAmount, feeAmount };
    if (idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys (key, request_path, request_hash, status, response_code, response_body)
         VALUES ($1, $2, $3, 'completed', 200, $4)
         ON CONFLICT (key) DO UPDATE SET status = 'completed', response_body = $4`,
        [idempotencyKey, `/ledger/capture`, paymentId, JSON.stringify(result)]
      );
    }

    logger.info(`[LEDGER] Recorded payment ${paymentId}: gross=${grossAmount}, fee=${feeAmount}, net=${netAmount}`);
    return result;
  }); // Default SERIALIZABLE isolation
}

/**
 * Record a refund — reverses ledger entries.
 */
async function recordRefund({
  paymentId,
  merchantId,
  refundAmount,
  feeRefundAmount = 0,
  currency = 'INR',
  idempotencyKey,
}) {
  if (!isAvailable()) {
    return { transactionId: uuidv4(), entries: [], sandbox: true };
  }

  const transactionId = uuidv4();

  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT * FROM idempotency_keys WHERE key = $1 AND status = 'completed'`,
        [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return JSON.parse(existing.rows[0].response_body || '{}');
      }
    }

    const merchantAcct = await ensureAccount(client, 'merchant', merchantId, currency);
    const customerAcct = await ensureAccount(client, 'customer_source', null, currency);

    // DEBIT merchant (money going out of merchant balance)
    await adjustBalance(client, merchantAcct.id, -refundAmount);
    await insertEntry(client, {
      transactionId, paymentId,
      accountId: merchantAcct.id,
      entryType: 'DEBIT',
      amount: refundAmount,
      description: `Refund for payment ${paymentId}`,
    });

    // CREDIT customer source (money going back)
    await adjustBalance(client, customerAcct.id, refundAmount);
    await insertEntry(client, {
      transactionId, paymentId,
      accountId: customerAcct.id,
      entryType: 'CREDIT',
      amount: refundAmount,
      description: `Refund for payment ${paymentId}`,
    });

    const result = { transactionId, refundAmount, paymentId };
    if (idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys (key, request_path, request_hash, status, response_body)
         VALUES ($1, '/ledger/refund', $2, 'completed', $3)
         ON CONFLICT (key) DO UPDATE SET status = 'completed', response_body = $3`,
        [idempotencyKey, paymentId, JSON.stringify(result)]
      );
    }

    logger.info(`[LEDGER] Recorded refund for ${paymentId}: amount=${refundAmount}`);
    return result;
  });
}

/**
 * Freeze funds for settlement (marks as pending payout).
 */
async function freezeFunds(merchantId, amount, currency = 'INR') {
  return withTransaction(async (client) => {
    const acct = await ensureAccount(client, 'merchant', merchantId, currency);
    
    if (acct.available_balance < amount) {
      throw new Error(`Insufficient available balance: have ${acct.available_balance}, need ${amount}`);
    }

    await client.query(
      `UPDATE ledger_accounts SET frozen_funds = frozen_funds + $1 WHERE id = $2`,
      [amount, acct.id]
    );

    logger.info(`[LEDGER] Froze ${amount} for merchant ${merchantId}`);
    return { frozen: amount, merchantId };
  });
}

/**
 * Release frozen funds after successful settlement payout.
 */
async function releaseFunds(merchantId, amount, currency = 'INR') {
  return withTransaction(async (client) => {
    const acct = await ensureAccount(client, 'merchant', merchantId, currency);

    // Move from merchant → settlement pool
    const txnId = uuidv4();

    // Debit merchant
    await adjustBalance(client, acct.id, -amount);
    await client.query(
      `UPDATE ledger_accounts SET frozen_funds = frozen_funds - $1 WHERE id = $2`,
      [amount, acct.id]
    );

    await insertEntry(client, {
      transactionId: txnId,
      accountId: acct.id,
      entryType: 'DEBIT',
      amount,
      description: `Settlement payout for merchant ${merchantId}`,
    });

    // Credit settlement pool
    const settlementAcct = await ensureAccount(client, 'settlement_pool', null, currency);
    await adjustBalance(client, settlementAcct.id, amount);
    await insertEntry(client, {
      transactionId: txnId,
      accountId: settlementAcct.id,
      entryType: 'CREDIT',
      amount,
      description: `Settlement payout for merchant ${merchantId}`,
    });

    logger.info(`[LEDGER] Released ${amount} for merchant ${merchantId} → settlement pool`);
    return { released: amount, transactionId: txnId };
  });
}

/**
 * Get ledger entries for a payment.
 */
async function getPaymentEntries(paymentId) {
  const result = await query(
    `SELECT le.*, la.account_type, la.merchant_id 
     FROM ledger_entries le 
     JOIN ledger_accounts la ON le.account_id = la.id 
     WHERE le.payment_id = $1 
     ORDER BY le.created_at`,
    [paymentId]
  );
  return result.rows;
}

/**
 * Get all entries for a merchant with pagination.
 */
async function getMerchantEntries(merchantId, { limit = 50, offset = 0 } = {}) {
  const result = await query(
    `SELECT le.* FROM ledger_entries le
     JOIN ledger_accounts la ON le.account_id = la.id
     WHERE la.merchant_id = $1
     ORDER BY le.created_at DESC
     LIMIT $2 OFFSET $3`,
    [merchantId, limit, offset]
  );
  return result.rows;
}

// ── Internal Helpers ────────────────────────────────────────────────────────

async function ensureAccount(client, accountType, merchantId, currency) {
  const params = merchantId
    ? [accountType, merchantId, currency]
    : [accountType, currency];

  const sql = merchantId
    ? `SELECT * FROM ledger_accounts WHERE account_type = $1 AND merchant_id = $2 AND currency = $3`
    : `SELECT * FROM ledger_accounts WHERE account_type = $1 AND merchant_id IS NULL AND currency = $2`;

  const existing = await client.query(sql, params);
  if (existing.rows.length > 0) return existing.rows[0];

  const insertSql = merchantId
    ? `INSERT INTO ledger_accounts (account_type, merchant_id, currency) VALUES ($1, $2, $3) RETURNING *`
    : `INSERT INTO ledger_accounts (account_type, currency) VALUES ($1, $2) RETURNING *`;

  const result = await client.query(insertSql, merchantId ? [accountType, merchantId, currency] : [accountType, currency]);
  return result.rows[0];
}

async function adjustBalance(client, accountId, amountDelta) {
  await client.query(
    `UPDATE ledger_accounts SET total_balance = total_balance + $1 WHERE id = $2`,
    [amountDelta, accountId]
  );
}

async function insertEntry(client, { transactionId, paymentId, accountId, entryType, amount, description }) {
  // Get running balance after adjustment
  const balResult = await client.query(
    `SELECT total_balance FROM ledger_accounts WHERE id = $1`,
    [accountId]
  );
  const runningBalance = balResult.rows[0].total_balance;

  const result = await client.query(
    `INSERT INTO ledger_entries 
       (transaction_id, payment_id, account_id, entry_type, amount, running_balance, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [transactionId, paymentId || null, accountId, entryType, amount, runningBalance, description]
  );

  return result.rows[0];
}

module.exports = {
  getOrCreateMerchantAccount,
  getOrCreateSystemAccount,
  getMerchantBalance,
  recordPaymentCapture,
  recordRefund,
  freezeFunds,
  releaseFunds,
  getPaymentEntries,
  getMerchantEntries,
};
