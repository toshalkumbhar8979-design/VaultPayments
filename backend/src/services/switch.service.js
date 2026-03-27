'use strict';

/**
 * NexusPay — Payment Switch Service
 * 
 * The core "brain" of NexusPay. Receives a payment intent,
 * consults the intelligent routing engine, selects a connector, and
 * orchestrates the entire transaction lifecycle with retry logic.
 */

const { v4: uuidv4 }             = require('uuid');
const connectors                 = require('../connectors');
const { payments, transactions } = require('../config/database');
const { getDb }                  = require('../config/database');
const { selectBestConnector, getConnectorMetrics } = require('../engine/router');
const logger                     = require('../utils/logger');

// ── Payment Intent Processing ─────────────────────────────────────────

async function processPayment(intent) {
  const {
    paymentId,
    merchantId,
    merchant,
    amount,
    currency,
    paymentMethod,
    description,
    cardToken,
    cardLast4,
    cardBrand,
    _testCardNumber,
  } = intent;

  // Step 1: Find compatible connectors
  const available = connectors.findConnectors({
    method:   paymentMethod,
    currency: currency,
  });

  if (available.length === 0) {
    logger.warn(`[SWITCH] No connector for method=${paymentMethod}, currency=${currency}`);
    return {
      success: false,
      error:   { code: 'NO_CONNECTOR', message: `No payment connector supports ${paymentMethod} in ${currency}` },
    };
  }

  // Step 2: Select the best connector using Intelligent Routing Engine
  const connector = await selectBestConnector(available, intent);
  logger.info(`[SWITCH] Selected connector: ${connector.name} for payment ${paymentId}`);

  // Step 3: Authorize through the connector
  let result;
  let retryCount = 0;

  while (retryCount <= connector.maxRetries) {
    try {
      result = await connector.authorize({
        paymentId,
        amount,
        currency,
        merchantName: merchant.business_name || merchant.name,
        merchantUpiId: merchant.upi_id || '',
        description,
        cardToken,
        cardLast4,
        cardBrand,
        _testCardNumber,
      });

      if (result.success || result.status === 'declined') break;

      logger.warn(`[SWITCH] Connector ${connector.name} failed (attempt ${retryCount + 1}). Retrying...`);
      retryCount++;
    } catch (err) {
      logger.error(`[SWITCH] Connector error (attempt ${retryCount + 1}):`, err);
      retryCount++;
      if (retryCount > connector.maxRetries) {
        result = { success: false, connectorRef: null, status: 'error', rawResponse: { error: err.message } };
      }
    }
  }

  // Step 4: Record connector metrics in DB
  await recordMetric(merchantId, connector.name, result.success, Date.now());

  return {
    success:       result.success,
    connectorName: connector.name,
    connectorRef:  result.connectorRef,
    status:        result.status,
    qrCode:        result.qrCode || null,
    virtualAccount: result.virtualAccount || null,
    threeDSUrl:    result.threeDSUrl || null,
    declineCode:   result.declineCode || null,
    rawResponse:   result.rawResponse,
    retryCount,
  };
}

async function capturePayment(merchantId, connectorName, connectorRef, options = {}) {
  const connector = connectors.getConnector(connectorName);
  const result    = await connector.capture(connectorRef, options);
  await recordMetric(merchantId, connectorName, result.success, Date.now());
  return result;
}

async function refundPayment(merchantId, connectorName, connectorRef, options = {}) {
  const connector = connectors.getConnector(connectorName);
  const result    = await connector.refund(connectorRef, options);
  await recordMetric(merchantId, connectorName, result.success, Date.now());
  return result;
}

async function voidPayment(connectorName, connectorRef) {
  const connector = connectors.getConnector(connectorName);
  return connector.void(connectorRef);
}

async function checkPaymentStatus(connectorName, connectorRef) {
  const connector = connectors.getConnector(connectorName);
  return connector.getStatus(connectorRef);
}

// ── Metrics Perseverance (Phase 2 Intelligent Routing) ─────────────

async function recordMetric(merchantId, connectorName, success, timestamp) {
  try {
    const isSuccess = success ? 1 : 0;
    const isFail = success ? 0 : 1;
    const period = new Date(timestamp).toISOString().slice(0, 7); // 'YYYY-MM'

    const db = getDb();
    
    const existing = await db.get(
      'SELECT * FROM connector_metrics WHERE connector_name = ? AND merchant_id = ? AND period = ?',
      [connectorName, merchantId, period]
    );

    if (existing) {
      const total = existing.total_attempts + 1;
      const successes = existing.successes + isSuccess;
      const failures = existing.failures + isFail;
      const rate = (successes / total) * 100;
      
      await db.run(
        'UPDATE connector_metrics SET total_attempts = ?, successes = ?, failures = ?, success_rate = ?, last_used_at = ? WHERE id = ?',
        [total, successes, failures, rate, new Date(timestamp).toISOString(), existing.id]
      );
    } else {
      await db.run(
        'INSERT INTO connector_metrics (id, connector_name, merchant_id, total_attempts, successes, failures, success_rate, last_used_at, period, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), connectorName, merchantId, 1, isSuccess, isFail, isSuccess ? 100 : 0, new Date(timestamp).toISOString(), period, new Date().toISOString()]
      );
    }
  } catch (err) {
    logger.error('[METRICS] Failed to record connector metric:', err);
  }
}

async function getMetrics(merchantId = '') {
  // We use the DB directly instead of an in-memory map
  const db = getDb();
  if (merchantId) {
    return await db.all('SELECT * FROM connector_metrics WHERE merchant_id = ?', [merchantId]);
  }
  return await db.all('SELECT * FROM connector_metrics');
}

module.exports = {
  processPayment,
  capturePayment,
  refundPayment,
  voidPayment,
  checkPaymentStatus,
  getMetrics,
};
