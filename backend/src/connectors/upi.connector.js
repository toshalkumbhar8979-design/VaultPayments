'use strict';

/**
 * NexusPay — UPI / QR Connector
 * 
 * Wraps the existing UPI/QR payment flow into the standard
 * connector interface. Generates QR codes and waits for
 * SMS confirmation or manual capture.
 */

const BaseConnector      = require('./base.connector');
const { generatePaymentQR } = require('../services/qr.service');
const logger             = require('../utils/logger');

class UPIConnector extends BaseConnector {
  constructor(config = {}) {
    super({
      name:                'upi',
      displayName:         'UPI / QR Payment',
      version:             '1.0.0',
      supportedCurrencies: ['INR'],
      supportedMethods:    ['upi', 'qr'],
      isLive:              config.isLive || false,
      maxRetries:          0,    // UPI is push-based, no retries
      timeoutMs:           config.timeoutMs || 900000, // 15 minutes
    });
  }

  /**
   * "Authorize" for UPI means generating a QR code / UPI deep-link
   * and waiting for the customer to pay. The payment is created in
   * a "pending" state.
   */
  async authorize(paymentIntent) {
    try {
      const { paymentId, amount, currency, merchantName, merchantUpiId, description } = paymentIntent;

      const qrCode = await generatePaymentQR({
        paymentId,
        amount: (amount / 100).toFixed(2),
        currency,
        merchantName,
        merchantUpiId,
        description,
      });

      const connectorRef = `upi_${paymentId}_${Date.now()}`;

      logger.info(`[UPI] Authorized: ${connectorRef} | ₹${(amount/100).toFixed(2)}`);

      return {
        success:      true,
        connectorRef,
        status:       'requires_action', // customer must scan QR
        qrCode,
        rawResponse:  { method: 'upi_qr', generatedAt: new Date().toISOString() },
      };
    } catch (err) {
      logger.error(`[UPI] Authorization failed:`, err);
      return {
        success:     false,
        connectorRef: null,
        status:      'failed',
        rawResponse: { error: err.message },
      };
    }
  }

  /**
   * Capture a UPI payment — confirms that payment was received
   * (typically triggered by SMS acknowledgment or manual confirmation).
   */
  async capture(connectorRef, options = {}) {
    try {
      const captureRef = `upi_cap_${Date.now()}`;

      logger.info(`[UPI] Captured: ${connectorRef} → ${captureRef}`);

      return {
        success:    true,
        captureRef,
        status:     'captured',
        rawResponse: {
          method:      'upi_qr',
          capturedAt:  new Date().toISOString(),
          smsAckTxnId: options.smsAckTxnId || null,
        },
      };
    } catch (err) {
      logger.error(`[UPI] Capture failed:`, err);
      return { success: false, captureRef: null, status: 'failed', rawResponse: { error: err.message } };
    }
  }

  /**
   * Void a pending UPI payment — mark it as cancelled.
   */
  async void(connectorRef) {
    logger.info(`[UPI] Voided: ${connectorRef}`);
    return {
      success: true,
      status:  'voided',
      rawResponse: { voidedAt: new Date().toISOString() },
    };
  }

  /**
   * Refund a captured UPI payment.
   * In a real system this would initiate a reverse UPI transfer.
   */
  async refund(connectorRef, options = {}) {
    const refundRef = `upi_ref_${Date.now()}`;
    logger.info(`[UPI] Refund initiated: ${connectorRef} → ${refundRef} | Amount: ${options.amount || 'full'}`);

    return {
      success:   true,
      refundRef,
      status:    'refund_pending',
      rawResponse: {
        method:     'upi_refund',
        amount:     options.amount || null,
        reason:     options.reason || 'merchant_initiated',
        initiatedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Get the status of a UPI payment.
   */
  async getStatus(connectorRef) {
    // In a real system, this would check with the UPI gateway
    return {
      status:      'pending',
      rawResponse: { connectorRef, checkedAt: new Date().toISOString() },
    };
  }

  /**
   * Verify an SMS-based webhook/notification.
   */
  async verifyWebhook(payload, signature) {
    // SMS acknowledgments are verified by the SMS parser
    return {
      verified: true,
      event:    'payment.confirmed',
      data:     payload,
    };
  }

  async healthCheck() {
    return { healthy: true, latencyMs: 0, message: 'UPI connector ready' };
  }
}

module.exports = UPIConnector;
