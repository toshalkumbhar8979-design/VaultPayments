'use strict';

/**
 * NexusPay — Subscription & Billing Engine
 * 
 * Manages recurring payments, plans, subscription lifecycles, and invoices.
 */

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../config/database');
const logger         = require('../utils/logger');

// ── Plan Management ───────────────────────────────────────────────────

async function createPlan(merchantId, { name, amount, currency = 'USD', interval = 'MONTH' }) {
  const db = getDb();
  const id = `plan_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
  const createdAt = new Date().toISOString();

  await db.run(
    'INSERT INTO billing_plans (id, merchant_id, name, amount, currency, interval, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, merchantId, name, amount, currency, interval, createdAt]
  );

  return { id, merchantId, name, amount, currency, interval, createdAt };
}

async function listPlans(merchantId) {
  return await getDb().all('SELECT * FROM billing_plans WHERE merchant_id = ? ORDER BY created_at DESC', [merchantId]);
}

// ── Subscription Lifecycle ────────────────────────────────────────────

function calculateNextBillingDate(interval, fromDate = new Date()) {
  const next = new Date(fromDate);
  if (interval === 'DAY') next.setDate(next.getDate() + 1);
  else if (interval === 'WEEK') next.setDate(next.getDate() + 7);
  else if (interval === 'YEAR') next.setFullYear(next.getFullYear() + 1);
  else next.setMonth(next.getMonth() + 1); // Default MONTH
  return next.toISOString();
}

async function createSubscription(merchantId, planId, customerEmail) {
  const db = getDb();
  const plan = await db.get('SELECT * FROM billing_plans WHERE id = ? AND merchant_id = ?', [planId, merchantId]);
  if (!plan) throw new Error('Plan not found or unauthorized');

  const id = `sub_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
  const nextBillingDate = calculateNextBillingDate(plan.interval);
  const createdAt = new Date().toISOString();

  await db.run(
    'INSERT INTO subscriptions (id, plan_id, merchant_id, customer_email, status, next_billing_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, planId, merchantId, customerEmail, 'active', nextBillingDate, createdAt]
  );

  logger.info(`[BILLING] Created subscription ${id} for ${customerEmail} on plan ${planId}`);
  
  // Instantly generate the first invoice
  await generateInvoice(id, merchantId, plan.amount);

  return { id, planId, customerEmail, status: 'active', nextBillingDate, createdAt };
}

async function cancelSubscription(merchantId, subscriptionId) {
  const db = getDb();
  const result = await db.run(
    `UPDATE subscriptions SET status = 'canceled' WHERE id = ? AND merchant_id = ?`,
    [subscriptionId, merchantId]
  );
  if (result.changes === 0) throw new Error('Subscription not found or already canceled');
  
  logger.info(`[BILLING] Canceled subscription ${subscriptionId}`);
  return { success: true, subscriptionId, status: 'canceled' };
}

async function listSubscriptions(merchantId) {
  return await getDb().all(`
    SELECT s.*, p.name as plan_name, p.amount as plan_amount, p.currency
    FROM subscriptions s
    JOIN billing_plans p ON s.plan_id = p.id
    WHERE s.merchant_id = ?
    ORDER BY s.created_at DESC
  `, [merchantId]);
}

// ── Invoicing Support ─────────────────────────────────────────────────

async function generateInvoice(subscriptionId, merchantId, amount) {
  const db = getDb();
  const id = `inv_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
  const createdAt = new Date().toISOString();

  await db.run(
    'INSERT INTO invoices (id, subscription_id, merchant_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, subscriptionId, merchantId, amount, 'pending', createdAt]
  );

  logger.info(`[BILLING] Generated invoice ${id} for subscription ${subscriptionId}`);
  return { id, subscriptionId, amount, status: 'pending', createdAt };
}

// ── Billing Scheduler ─────────────────────────────────────────────────

/**
 * Sweeps the database for active subscriptions whose next_billing_date is past due.
 * Generates an invoice and advances the billing date.
 * In a real-world scenario, this would also trigger a payment capture via the Switch.
 */
async function processDueSubscriptions() {
  const db = getDb();
  const now = new Date().toISOString();

  const dueSubs = await db.all(`
    SELECT s.*, p.amount, p.interval 
    FROM subscriptions s
    JOIN billing_plans p ON s.plan_id = p.id
    WHERE s.status = 'active' AND s.next_billing_date <= ?
  `, [now]);

  if (dueSubs.length === 0) return 0;

  logger.info(`[BILLING] Scheduler found ${dueSubs.length} subscriptions due for billing.`);

  let processedCount = 0;
  for (const sub of dueSubs) {
    try {
      // 1. Generate Invoice (Pending payment)
      await generateInvoice(sub.id, sub.merchant_id, sub.amount);

      // 2. Advance the next billing date
      const nextDate = calculateNextBillingDate(sub.interval, new Date());
      await db.run('UPDATE subscriptions SET next_billing_date = ? WHERE id = ?', [nextDate, sub.id]);
      
      processedCount++;
    } catch (err) {
      logger.error(`[BILLING] Failed to process subscription ${sub.id}:`, err);
    }
  }

  return processedCount;
}

let schedulerTimer = null;

function startBillingScheduler(intervalMs = 60000) { // Default every 1 minute for testing
  if (schedulerTimer) clearInterval(schedulerTimer);
  
  logger.info(`[BILLING] Scheduler activated. Checking due subscriptions every ${intervalMs}ms.`);
  schedulerTimer = setInterval(() => {
    processDueSubscriptions().catch(err => logger.error('[BILLING] Scheduler error:', err));
  }, intervalMs);
}

module.exports = {
  createPlan,
  listPlans,
  createSubscription,
  cancelSubscription,
  listSubscriptions,
  generateInvoice,
  processDueSubscriptions,
  startBillingScheduler
};
