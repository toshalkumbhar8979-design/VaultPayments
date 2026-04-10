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
const PaymentClient              = require('../prism/PaymentClient');
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

  // Step 2: Select the best connector logic
  const connectorDef = await selectBestConnector(available, intent);
  logger.info(`[SWITCH] Selected connector: ${connectorDef.name} for payment ${paymentId}`);

  // Step 3: Authorize through Prism PaymentClient
  let result;
  let retryCount = 0;

  // We construct the unified config like Hyperswitch
  const config = {
    connectorConfig: {
      [connectorDef.name]: {
        isLive: connectorDef.isLive,
        apiKey: 'masked', // pulled by Vault natively behind scenes
      }
    }
  };

  const client = new PaymentClient(config);

  while (retryCount <= connectorDef.maxRetries) {
    try {
      result = await client.authorize({
        merchantTransactionId: paymentId,
        amount: { minorAmount: amount, currency },
        paymentMethod: { [paymentMethod]: { cardToken, cardLast4, cardBrand, _testCardNumber } },
        description,
        merchantName: merchant.business_name || merchant.name,
        merchantUpiId: merchant.upi_id || ''
      });

      // PaymentClient handles mapping to generic success/status model
      if (result.success || result.status === 'FAILED') break;

      logger.warn(`[SWITCH] Connector ${connectorDef.name} failed (attempt ${retryCount + 1}). Retrying...`);
      retryCount++;
    } catch (err) {
      logger.error(`[SWITCH] Prism client error (attempt ${retryCount + 1}):`, err);
      retryCount++;
      if (retryCount > connectorDef.maxRetries) {
        result = { success: false, connectorRef: null, status: 'FAILED', rawResponse: { error: err.message } };
      }
    }
  }

  // Step 4: Record connector metrics in DB
  await recordMetric(merchantId, connectorDef.name, result.success, Date.now());

  return {
    success:       result.success,
    connectorName: connectorDef.name,
    connectorRef:  result.connectorRef,
    status:        result.status,
    qrCode:        result.action?.payload || null,
    virtualAccount: null,
    threeDSUrl:    null,
    declineCode:   null,
    rawResponse:   result.rawResponse,
    retryCount,
  };
}

async function capturePayment(merchantId, connectorName, connectorRef, options = {}) {
  const config = { connectorConfig: { [connectorName]: {} } };
  const client = new PaymentClient(config);
  const result = await client.capture(connectorRef, options);
  await recordMetric(merchantId, connectorName, result.success, Date.now());
  return result;
}

async function refundPayment(merchantId, connectorName, connectorRef, options = {}) {
  const config = { connectorConfig: { [connectorName]: {} } };
  const client = new PaymentClient(config);
  const result = await client.refund(connectorRef, options);
  await recordMetric(merchantId, connectorName, result.success, Date.now());
  return result;
}

async function voidPayment(connectorName, connectorRef) {
  const config = { connectorConfig: { [connectorName]: {} } };
  const client = new PaymentClient(config);
  return client.void(connectorRef);
}

async function checkPaymentStatus(connectorName, connectorRef) {
  const config = { connectorConfig: { [connectorName]: {} } };
  const client = new PaymentClient(config);
  return client.getStatus(connectorRef);
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
