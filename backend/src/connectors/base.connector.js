'use strict';

/**
 * NexusPay — Base Connector Interface
 * 
 * Every payment connector (UPI, Card, Bank Transfer, Wallet, etc.)
 * MUST extend this class and implement all abstract methods.
 * 
 * This is the standard contract that the Payment Switch uses to
 * interact with any payment processor uniformly.
 */

class BaseConnector {
  constructor(config = {}) {
    if (new.target === BaseConnector) {
      throw new Error('BaseConnector is abstract — you must extend it.');
    }
    this.name       = config.name       || 'unknown';
    this.displayName = config.displayName || 'Unknown Connector';
    this.version    = config.version    || '1.0.0';
    this.supportedCurrencies = config.supportedCurrencies || ['INR'];
    this.supportedMethods    = config.supportedMethods    || [];
    this.isLive     = config.isLive     || false;
    this.maxRetries = config.maxRetries || 2;
    this.timeoutMs  = config.timeoutMs  || 30000;
  }

  // ── Lifecycle Methods ─────────────────────────────────────────────────

  /**
   * Authorize a payment — validate and reserve funds.
   * @param {Object} paymentIntent - { amount, currency, customer, metadata }
   * @returns {Object} - { success, connectorRef, status, rawResponse }
   */
  async authorize(paymentIntent) {
    throw new Error(`${this.name}.authorize() not implemented`);
  }

  /**
   * Capture an authorized payment — actually debit the funds.
   * @param {string} connectorRef - Reference from authorize()
   * @param {Object} options - { amount (for partial capture) }
   * @returns {Object} - { success, captureRef, status, rawResponse }
   */
  async capture(connectorRef, options = {}) {
    throw new Error(`${this.name}.capture() not implemented`);
  }

  /**
   * Void an authorized (but not captured) payment.
   * @param {string} connectorRef - Reference from authorize()
   * @returns {Object} - { success, status, rawResponse }
   */
  async void(connectorRef) {
    throw new Error(`${this.name}.void() not implemented`);
  }

  /**
   * Refund a captured payment (full or partial).
   * @param {string} connectorRef - Reference from capture()
   * @param {Object} options - { amount, reason }
   * @returns {Object} - { success, refundRef, status, rawResponse }
   */
  async refund(connectorRef, options = {}) {
    throw new Error(`${this.name}.refund() not implemented`);
  }

  /**
   * Check the status of a payment at the connector.
   * @param {string} connectorRef - Reference from any lifecycle step
   * @returns {Object} - { status, amount, rawResponse }
   */
  async getStatus(connectorRef) {
    throw new Error(`${this.name}.getStatus() not implemented`);
  }

  /**
   * Verify a webhook/notification from this connector.
   * @param {Object} payload - Raw webhook body
   * @param {string} signature - Webhook signature header
   * @returns {Object} - { verified, event, data }
   */
  async verifyWebhook(payload, signature) {
    throw new Error(`${this.name}.verifyWebhook() not implemented`);
  }

  // ── Utility Methods ──────────────────────────────────────────────────

  /**
   * Check if this connector supports a given currency.
   */
  supportsCurrency(currency) {
    return this.supportedCurrencies.includes(currency);
  }

  /**
   * Check if this connector supports a given payment method.
   */
  supportsMethod(method) {
    return this.supportedMethods.includes(method);
  }

  /**
   * Health check — is the connector reachable?
   * @returns {Object} - { healthy, latencyMs, message }
   */
  async healthCheck() {
    return { healthy: true, latencyMs: 0, message: 'OK (not implemented)' };
  }

  /**
   * Get connector metadata for the dashboard.
   */
  getInfo() {
    return {
      name:       this.name,
      displayName: this.displayName,
      version:    this.version,
      currencies: this.supportedCurrencies,
      methods:    this.supportedMethods,
      isLive:     this.isLive,
    };
  }
}

module.exports = BaseConnector;
