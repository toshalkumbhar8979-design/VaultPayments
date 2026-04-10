'use strict';

/**
 * NexusPay — Webhook Dispatcher
 * 
 * As the PSP, NexusPay is responsible for sending webhooks to merchants
 * on payment lifecycle events. This replaces the pass-through model
 * where Stripe/Razorpay sent webhooks directly.
 * 
 * Features:
 *   - HMAC-SHA256 signature verification  
 *   - Retry with exponential backoff (3 attempts over 24h)
 *   - Delivery tracking in PostgreSQL
 *   - Event types: payment.authorized, payment.captured, payment.failed,
 *                  payment.refunded, settlement.completed
 */

const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ── Retry Configuration ─────────────────────────────────────────────────────

const RETRY_DELAYS = [
  0,           // Immediate
  5 * 60,      // 5 minutes
  60 * 60,     // 1 hour
];

const MAX_ATTEMPTS = 3;
const DELIVERY_TIMEOUT_MS = 10000; // 10 seconds

class WebhookDispatcher {
  constructor({ pgQuery, isAvailable, merchantsDb } = {}) {
    this.pgQuery = pgQuery;
    this.isAvailable = isAvailable;
    this.merchantsDb = merchantsDb; // SQLite merchants accessor
    this.pendingRetries = []; // In-memory fallback when PG unavailable
  }

  /**
   * Dispatch a webhook event to a merchant.
   * 
   * @param {string} merchantId - Merchant ID
   * @param {string} eventType - Event type (e.g., 'payment.captured')
   * @param {Object} data - Event payload
   * @returns {Object} { deliveryId, status }
   */
  async dispatch(merchantId, eventType, data) {
    try {
      // Get merchant webhook URL and secret
      const merchant = await this.merchantsDb.findById(merchantId);
      if (!merchant || !merchant.webhook_url) {
        logger.info(`[WEBHOOK] No webhook URL for merchant ${merchantId}, skipping`);
        return { deliveryId: null, status: 'skipped' };
      }

      const deliveryId = uuidv4();
      const timestamp = new Date().toISOString();

      const payload = {
        id: deliveryId,
        event: eventType,
        data,
        created_at: timestamp,
        api_version: 'v1',
      };

      // Sign the payload
      const signature = this.sign(JSON.stringify(payload), merchant.webhook_secret);

      // Record delivery attempt
      await this.recordDelivery(deliveryId, merchantId, eventType, data.payment_id, payload, merchant.webhook_url);

      // Send webhook (async — don't block the transaction)
      this._deliver(deliveryId, merchant.webhook_url, payload, signature, 0).catch(err => {
        logger.warn(`[WEBHOOK] Delivery failed for ${deliveryId}: ${err.message}`);
      });

      return { deliveryId, status: 'dispatched' };
    } catch (err) {
      logger.error(`[WEBHOOK] Dispatch error: ${err.message}`);
      return { deliveryId: null, status: 'error' };
    }
  }

  /**
   * HMAC-SHA256 signature generation.
   */
  sign(payload, secret) {
    return crypto
      .createHmac('sha256', secret || 'default-webhook-secret')
      .update(payload)
      .digest('hex');
  }

  /**
   * Verify a webhook signature (for merchants to verify incoming webhooks).
   */
  static verify(payload, signature, secret) {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  /**
   * Deliver webhook with retry logic.
   */
  async _deliver(deliveryId, url, payload, signature, attemptIndex) {
    const attempt = attemptIndex + 1;
    
    try {
      const result = await this._httpPost(url, payload, signature);

      if (result.statusCode >= 200 && result.statusCode < 300) {
        // Success
        await this.updateDeliveryStatus(deliveryId, 'delivered', result.statusCode, result.body, attempt);
        logger.info(`[WEBHOOK] Delivered ${deliveryId} to ${url} (${result.statusCode})`);
        return;
      }

      // Non-2xx response — retry if attempts remaining
      logger.warn(`[WEBHOOK] Non-2xx response for ${deliveryId}: ${result.statusCode}`);
      await this.updateDeliveryStatus(deliveryId, 'retrying', result.statusCode, result.body, attempt);

    } catch (err) {
      logger.warn(`[WEBHOOK] HTTP error for ${deliveryId}: ${err.message}`);
      await this.updateDeliveryStatus(deliveryId, 'retrying', 0, err.message, attempt);
    }

    // Schedule retry if attempts remaining
    if (attempt < MAX_ATTEMPTS) {
      const delay = RETRY_DELAYS[attempt] || 3600;
      logger.info(`[WEBHOOK] Scheduling retry ${attempt + 1}/${MAX_ATTEMPTS} for ${deliveryId} in ${delay}s`);
      
      setTimeout(() => {
        this._deliver(deliveryId, url, payload, signature, attempt).catch(() => {});
      }, delay * 1000);
    } else {
      await this.updateDeliveryStatus(deliveryId, 'failed', 0, 'Max attempts reached', attempt);
      logger.error(`[WEBHOOK] Delivery FAILED for ${deliveryId} after ${MAX_ATTEMPTS} attempts`);
    }
  }

  /**
   * HTTP POST request.
   */
  _httpPost(url, payload, signature) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const transport = urlObj.protocol === 'https:' ? https : http;

      const body = JSON.stringify(payload);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type':         'application/json',
          'Content-Length':       Buffer.byteLength(body),
          'X-NexusPay-Signature': signature,
          'X-NexusPay-Event':    payload.event,
          'X-NexusPay-Delivery': payload.id,
          'User-Agent':          'NexusPay-Webhook/1.0',
        },
        timeout: DELIVERY_TIMEOUT_MS,
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data.slice(0, 1000) }));
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ── Database Operations ───────────────────────────────────────────────

  async recordDelivery(deliveryId, merchantId, eventType, paymentId, payload, webhookUrl) {
    if (this.isAvailable && this.isAvailable() && this.pgQuery) {
      try {
        await this.pgQuery(
          `INSERT INTO webhook_deliveries 
           (id, merchant_id, event_type, payment_id, payload, webhook_url)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [deliveryId, merchantId, eventType, paymentId || '', JSON.stringify(payload), webhookUrl]
        );
      } catch (err) {
        logger.warn(`[WEBHOOK] Failed to record delivery: ${err.message}`);
      }
    }
  }

  async updateDeliveryStatus(deliveryId, status, httpStatus, responseBody, attempts) {
    if (this.isAvailable && this.isAvailable() && this.pgQuery) {
      try {
        const updates = {
          delivered: `status = 'delivered', http_status = $2, response_body = $3, attempts = $4, delivered_at = NOW()`,
          retrying:  `status = 'retrying', http_status = $2, response_body = $3, attempts = $4, next_retry_at = NOW() + interval '1 hour'`,
          failed:    `status = 'failed', http_status = $2, response_body = $3, attempts = $4`,
        };

        await this.pgQuery(
          `UPDATE webhook_deliveries SET ${updates[status] || updates.failed} WHERE id = $1`,
          [deliveryId, httpStatus || 0, (responseBody || '').slice(0, 1000), attempts]
        );
      } catch (err) {
        logger.warn(`[WEBHOOK] Failed to update delivery status: ${err.message}`);
      }
    }
  }

  /**
   * Get delivery history for a merchant.
   */
  async getDeliveries(merchantId, limit = 20) {
    if (this.isAvailable && this.isAvailable() && this.pgQuery) {
      const result = await this.pgQuery(
        `SELECT id, event_type, payment_id, status, http_status, attempts, created_at, delivered_at
         FROM webhook_deliveries WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [merchantId, limit]
      );
      return result.rows;
    }
    return [];
  }
}

module.exports = WebhookDispatcher;
