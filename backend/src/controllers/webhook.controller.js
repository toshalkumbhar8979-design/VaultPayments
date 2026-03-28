'use strict';

const { payments, merchants } = require('../config/database');
const connectors = require('../connectors');
const { signPayload } = require('../services/crypto.service');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');
const { PAYMENT_STATUS } = require('../config/constants');

/**
 * Universal Webhook Handler
 * Route: POST /api/v1/webhooks/:connectorId
 */
const handleWebhook = async (req, res) => {
  const { connectorId } = req.params;
  const signature = req.headers['x-hub-signature'] || req.headers['x-paypal-transmission-sig'] || req.headers['stripe-signature'];
  const payload = req.body;

  try {
    const connector = connectors.getConnector(connectorId);
    if (!connector) {
      logger.error(`[WEBHOOK] Connector not found: ${connectorId}`);
      return res.status(404).send('Connector not found');
    }

    // 1. Verify Webhook Authenticity
    const { verified, event, data } = await connector.verifyWebhook(payload, signature);
    if (!verified) {
      logger.warn(`[WEBHOOK] Invalid signature for connector: ${connectorId}`);
      return res.status(401).send('Invalid signature');
    }

    logger.info(`[WEBHOOK] Received event ${event} from ${connectorId}`);

    // 2. Identify the internal Payment record
    // Most PSPs provide the original payment reference in a metadata field or order_id
    const connectorRef = data.resource_id || data.id || payload.id;
    const payment = await payments.findByConnectorRef(connectorId, connectorRef);

    if (!payment) {
      logger.error(`[WEBHOOK] No matching payment for connectorRef: ${connectorRef}`);
      return res.status(404).send('Payment not found');
    }

    // 3. Map status and update database
    let newStatus = payment.status;
    if (['captured', 'COMPLETED', 'SUCCEEDED', 'success'].includes(data.status)) {
        newStatus = PAYMENT_STATUS.CAPTURED;
    } else if (['failed', 'DECLINED', 'FAILED'].includes(data.status)) {
        newStatus = PAYMENT_STATUS.FAILED;
    }

    if (newStatus !== payment.status) {
      await payments.update(payment.id, { 
        status: newStatus,
        captured_at: newStatus === PAYMENT_STATUS.CAPTURED ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      });
      logger.info(`[WEBHOOK] Payment ${payment.id} updated to ${newStatus}`);

      // 4. Trigger Merchant Notification (if success)
      const merchant = await merchants.findById(payment.merchant_id);
      if (merchant && merchant.webhook_url) {
        fireMerchantWebhook(merchant, payment, newStatus).catch(err => {
            logger.error(`[WEBHOOK] Failed to notify merchant: ${err.message}`);
        });
      }
    }

    return res.status(200).send('Event processed');
  } catch (err) {
    logger.error(`[WEBHOOK] Error handling event: ${err.stack}`);
    return res.status(500).send('Internal server error');
  }
};

/**
 * Fire notification back to the merchant's server
 */
async function fireMerchantWebhook(merchant, payment, status) {
    const event = status === PAYMENT_STATUS.CAPTURED ? 'payment.captured' : `payment.${status}`;
    const payload = JSON.stringify({ event, data: payment, timestamp: Date.now() });
    const sig = signPayload(payload, merchant.webhook_secret);

    try {
        const response = await fetch(merchant.webhook_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-NexusPay-Signature': sig,
                'X-NexusPay-Event': event,
                'User-Agent': `${process.env.PLATFORM_NAME || 'NexusPay'}-Webhook/1.0`,
            },
            body: payload,
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        logger.info(`[WEBHOOK] Successfully notified merchant for payment: ${payment.id}`);
    } catch (err) {
        logger.error(`[WEBHOOK] Webhook delivery failed for merchant ${merchant.id}: ${err.message}`);
    }
}

module.exports = { handleWebhook };
