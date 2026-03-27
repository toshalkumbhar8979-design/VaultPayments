'use strict';

/**
 * NexusPay — Bank Transfer Connector (Simulator)
 * 
 * Simulates NEFT / IMPS / RTGS bank transfer flows.
 * Generates virtual bank account details for collection.
 */

const BaseConnector = require('./base.connector');
const logger        = require('../utils/logger');

class BankTransferConnector extends BaseConnector {
  constructor(config = {}) {
    super({
      name:                'bank_transfer',
      displayName:         'Bank Transfer (NEFT/IMPS/RTGS)',
      version:             '1.0.0',
      supportedCurrencies: ['INR'],
      supportedMethods:    ['bank_transfer', 'neft', 'imps', 'rtgs'],
      isLive:              false,
      maxRetries:          0,
      timeoutMs:           config.timeoutMs || 86400000, // 24 hours
    });
  }

  async authorize(paymentIntent) {
    try {
      const { paymentId, amount, currency } = paymentIntent;
      const connectorRef = `bnk_${paymentId}_${Date.now()}`;

      // Generate virtual account details
      const virtualAccount = {
        accountNumber:  `NPAY${Date.now().toString().slice(-10)}`,
        ifscCode:       'NPAY0000001',
        bankName:       'NexusPay Virtual Bank',
        beneficiaryName: 'NexusPay Payment Collection',
        utrReference:   connectorRef,
      };

      logger.info(`[BANK] Virtual account created: ${connectorRef} | ₹${(amount/100).toFixed(2)}`);

      return {
        success:       true,
        connectorRef,
        status:        'awaiting_transfer',
        virtualAccount,
        rawResponse:   { generatedAt: new Date().toISOString() },
      };
    } catch (err) {
      logger.error(`[BANK] Authorization failed:`, err);
      return { success: false, connectorRef: null, status: 'failed', rawResponse: { error: err.message } };
    }
  }

  async capture(connectorRef, options = {}) {
    const captureRef = `bnk_cap_${Date.now()}`;
    logger.info(`[BANK] Captured: ${connectorRef} → ${captureRef}`);
    return {
      success:    true,
      captureRef,
      status:     'captured',
      rawResponse: { utr: options.utr || `UTR${Date.now()}`, capturedAt: new Date().toISOString() },
    };
  }

  async void(connectorRef) {
    logger.info(`[BANK] Voided: ${connectorRef}`);
    return { success: true, status: 'voided', rawResponse: { voidedAt: new Date().toISOString() } };
  }

  async refund(connectorRef, options = {}) {
    const refundRef = `bnk_ref_${Date.now()}`;
    logger.info(`[BANK] Refund: ${connectorRef} → ${refundRef}`);
    return {
      success:   true,
      refundRef,
      status:    'refund_processing',
      rawResponse: { estimatedSettlement: '2-3 business days', initiatedAt: new Date().toISOString() },
    };
  }

  async getStatus(connectorRef) {
    return { status: 'awaiting_transfer', rawResponse: { connectorRef } };
  }

  async verifyWebhook(payload, signature) {
    return { verified: true, event: 'bank_transfer.received', data: payload };
  }

  async healthCheck() {
    return { healthy: true, latencyMs: 0, message: 'Bank transfer connector ready' };
  }
}

module.exports = BankTransferConnector;
