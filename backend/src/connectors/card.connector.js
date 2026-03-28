'use strict';

/**
 * NexusPay — Card Simulator Connector
 * 
 * A test card connector that simulates card payments.
 * Uses test card number patterns (like Stripe) to determine outcomes:
 *   4242 4242 4242 4242 → Success
 *   4000 0000 0000 0002 → Decline
 *   4000 0000 0000 9995 → Insufficient funds
 *   4000 0000 0000 0069 → Expired card
 *   4000 0000 0000 0127 → Incorrect CVC
 * 
 * Security: Uses tokenized references only.
 * Raw card data is NEVER stored (PCI DSS compliant).
 */

const BaseConnector = require('./base.connector');
const logger        = require('../utils/logger');

// ── Test Card Outcomes ──────────────────────────────────────────────────
const TEST_CARDS = {
  '4242424242424242': { outcome: 'authorized',    message: 'Payment authorized' },
  '4000000000000002': { outcome: 'declined',      message: 'Card declined' },
  '4000000000009995': { outcome: 'declined',      message: 'Insufficient funds' },
  '4000000000000069': { outcome: 'declined',      message: 'Expired card' },
  '4000000000000127': { outcome: 'declined',      message: 'Incorrect CVC' },
  '5555555555554444': { outcome: 'authorized',    message: 'Mastercard authorized' },
  '3782822463100005': { outcome: 'authorized',    message: 'Amex authorized' },
  '4000000000003220': { outcome: '3ds_required',  message: '3D Secure authentication required' },
};

// ── Luhn Validation (PCI Compliance Skill) ──────────────────────────────
function isValidLuhn(cardNumber) {
  const digits = cardNumber.replace(/\D/g, '').split('').reverse().map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// ── Card Brand Detection ────────────────────────────────────────────────
function detectBrand(cardNumber) {
  const num = cardNumber.replace(/\D/g, '');
  if (/^4/.test(num))                     return 'visa';
  if (/^5[1-5]/.test(num))               return 'mastercard';
  if (/^3[47]/.test(num))                return 'amex';
  if (/^6(?:011|5)/.test(num))           return 'discover';
  if (/^35(?:2[89]|[3-8])/.test(num))    return 'jcb';
  if (/^3(?:0[0-5]|[68])/.test(num))     return 'diners';
  return 'unknown';
}

class CardSimulatorConnector extends BaseConnector {
  constructor(config = {}) {
    super({
      name:                'card_simulator',
      displayName:         'Card Payment (Simulator)',
      version:             '1.0.0',
      supportedCurrencies: ['INR', 'USD', 'EUR', 'GBP'],
      supportedMethods:    ['card', 'credit_card', 'debit_card'],
      isLive:              false, // Always test mode
      maxRetries:          2,
      timeoutMs:           config.timeoutMs || 15000,
    });

    // Simulated in-memory "processor" state
    this._authorizations = new Map();
    this._captures       = new Map();
  }

  /**
   * Authorize a card payment.
   * Uses the token reference (NOT raw card number) to look up the test outcome.
   */
  async authorize(paymentIntent) {
    try {
      const { paymentId, amount, currency, cardToken, cardLast4, cardBrand } = paymentIntent;

      // Simulate network latency (50-200ms)
      await this._simulateLatency();

      // Look up test card outcome by token metadata
      const testCardNumber = paymentIntent._testCardNumber || '4242424242424242';
      const testOutcome    = TEST_CARDS[testCardNumber] || TEST_CARDS['4242424242424242'];

      if (testOutcome.outcome === 'declined') {
        logger.warn(`[CARD] Declined: ${paymentId} | ${testOutcome.message}`);
        return {
          success:      false,
          connectorRef: null,
          status:       'declined',
          declineCode:  testOutcome.message.toLowerCase().replace(/ /g, '_'),
          rawResponse:  { message: testOutcome.message, cardBrand, cardLast4 },
        };
      }

      if (testOutcome.outcome === '3ds_required') {
        const connectorRef = `card_3ds_${paymentId}_${Date.now()}`;
        this._authorizations.set(connectorRef, { amount, currency, status: '3ds_pending', paymentId });

        logger.info(`[CARD] 3DS Required: ${connectorRef}`);
        return {
          success:      true,
          connectorRef,
          status:       'requires_3ds',
          threeDSUrl:   `https://nexuspay-3ds.example.com/authenticate/${connectorRef}`,
          rawResponse:  { message: '3D Secure required', cardBrand, cardLast4 },
        };
      }

      // Success path
      const connectorRef = `card_auth_${paymentId}_${Date.now()}`;
      this._authorizations.set(connectorRef, { amount, currency, status: 'authorized', paymentId });

      logger.info(`[CARD] Authorized: ${connectorRef} | ${currency} ${(amount/100).toFixed(2)} | ${cardBrand} •••• ${cardLast4}`);

      return {
        success:      true,
        connectorRef,
        status:       'authorized',
        rawResponse:  {
          authCode:     `AUTH${Math.random().toString(36).substring(2,8).toUpperCase()}`,
          cardBrand,
          cardLast4,
          message:      testOutcome.message,
        },
      };
    } catch (err) {
      logger.error(`[CARD] Authorization error:`, err);
      return { success: false, connectorRef: null, status: 'error', rawResponse: { error: err.message } };
    }
  }

  /**
   * Capture an authorized card payment.
   */
  async capture(connectorRef, options = {}) {
    try {
      const auth = this._authorizations.get(connectorRef);
      if (!auth) {
        return { success: false, captureRef: null, status: 'not_found', rawResponse: { message: 'Authorization not found' } };
      }
      if (auth.status !== 'authorized') {
        return { success: false, captureRef: null, status: 'invalid_state', rawResponse: { message: `Cannot capture: status is ${auth.status}` } };
      }

      await this._simulateLatency();

      const captureAmount = options.amount || auth.amount;
      const captureRef    = `card_cap_${Date.now()}`;

      auth.status = 'captured';
      this._captures.set(captureRef, { connectorRef, amount: captureAmount, capturedAt: new Date().toISOString() });

      logger.info(`[CARD] Captured: ${connectorRef} → ${captureRef} | ${auth.currency} ${(captureAmount/100).toFixed(2)}`);

      return {
        success:    true,
        captureRef,
        status:     'captured',
        rawResponse: { amount: captureAmount, capturedAt: new Date().toISOString() },
      };
    } catch (err) {
      logger.error(`[CARD] Capture error:`, err);
      return { success: false, captureRef: null, status: 'error', rawResponse: { error: err.message } };
    }
  }

  /**
   * Void an authorization (no funds captured yet).
   */
  async void(connectorRef) {
    const auth = this._authorizations.get(connectorRef);
    if (!auth) return { success: false, status: 'not_found' };
    auth.status = 'voided';
    logger.info(`[CARD] Voided: ${connectorRef}`);
    return { success: true, status: 'voided', rawResponse: { voidedAt: new Date().toISOString() } };
  }

  /**
   * Refund a captured payment.
   */
  async refund(connectorRef, options = {}) {
    await this._simulateLatency();
    const refundRef = `card_ref_${Date.now()}`;
    logger.info(`[CARD] Refund: ${connectorRef} → ${refundRef}`);
    return {
      success:   true,
      refundRef,
      status:    'refunded',
      rawResponse: { amount: options.amount, reason: options.reason, refundedAt: new Date().toISOString() },
    };
  }

  /**
   * Get status of a payment.
   * In the simulator, we automatically transition 'authorized' to 'captured'
   * after 5 seconds to simulate real-world processing.
   */
  async getStatus(connectorRef) {
    const auth = this._authorizations.get(connectorRef);
    if (!auth) return { status: 'not_found', rawResponse: {} };

    // Simulation: if authorized and more than 5 seconds have passed, auto-capture
    const CREATED_MS = parseInt(connectorRef.split('_').pop());
    const ELAPSED_MS = Date.now() - (CREATED_MS || 0);

    if (auth.status === 'authorized' && ELAPSED_MS > 5000) {
        logger.info(`[CARD] Auto-capturing simulated payment: ${connectorRef} | Wait: ${ELAPSED_MS}ms`);
        auth.status = 'captured';
    }

    return { status: auth.status, amount: auth.amount, rawResponse: auth };
  }

  async verifyWebhook(payload, signature) {
    return { verified: true, event: payload.event || 'unknown', data: payload };
  }

  async healthCheck() {
    return { healthy: true, latencyMs: Math.floor(Math.random() * 100) + 20, message: 'Card simulator online' };
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  async _simulateLatency() {
    const ms = Math.floor(Math.random() * 150) + 50;
    return new Promise(r => setTimeout(r, ms));
  }
}

// Export static utils
CardSimulatorConnector.isValidLuhn  = isValidLuhn;
CardSimulatorConnector.detectBrand  = detectBrand;
CardSimulatorConnector.TEST_CARDS   = TEST_CARDS;

module.exports = CardSimulatorConnector;
