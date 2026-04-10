'use strict';

/**
 * VaultPayments — Prism Abstraction Library
 * 
 * Stateless, unified connector library that adapts the generic
 * PaymentServiceAuthorizeRequest into processor-specific schemas.
 * Replaces direct usages of different connectors with a single interface.
 */

const connectors = require('../connectors');
const logger = require('../utils/logger');

class PaymentClient {
  /**
   * Initialize a Payment Client with a specific ConnectorConfig.
   * @param {Object} config - { connectorConfig: { stripe: { apiKey: '...' } } }
   */
  constructor(config = {}) {
    this.config = config;
    this.connectorName = Object.keys(config.connectorConfig || {})[0] || 'upi';
    this.connector = connectors.getConnector(this.connectorName);

    if (!this.connector) {
      throw new Error(`IntegrationError: Connector '${this.connectorName}' not found or not supported.`);
    }

    // Initialize connector dynamically with config
    this.connectorInstance = new this.connector.constructor(config.connectorConfig[this.connectorName]);
  }

  /**
   * Unified Authorize Request
   * @param {Object} request - PaymentServiceAuthorizeRequest definition
   * {
   *   merchantTransactionId: '...',
   *   amount: { minorAmount: 1000, currency: 'USD' },
   *   paymentMethod: { card: { ... } } // or { upi: { ... } }
   * }
   */
  async authorize(request) {
    try {
      logger.info(`[PRISM] Authorize via ${this.connectorName} for Txn: ${request.merchantTransactionId}`);
      // Adapt unified request to internal payload
      const adapterRequest = {
        paymentId: request.merchantTransactionId,
        amount: request.amount.minorAmount,
        currency: request.amount.currency,
        paymentMethod: Object.keys(request.paymentMethod)[0], // e.g. 'card', 'upi'
        methodData: Object.values(request.paymentMethod)[0],
        description: request.description || '',
      };
      
      const response = await this.connectorInstance.authorize(adapterRequest);
      return this._mapStandardResponse(response);
    } catch (err) {
      logger.error(`[PRISM] ConnectorResponseTransformationError: ${err.message}`);
      throw err;
    }
  }

  async capture(connectorRef, options = {}) {
    const response = await this.connectorInstance.capture(connectorRef, options);
    return this._mapStandardResponse(response);
  }

  async void(connectorRef) {
    const response = await this.connectorInstance.void(connectorRef);
    return this._mapStandardResponse(response);
  }

  async refund(connectorRef, options = {}) {
    const response = await this.connectorInstance.refund(connectorRef, options);
    return this._mapStandardResponse(response);
  }

  async getStatus(connectorRef) {
    const response = await this.connectorInstance.getStatus(connectorRef);
    return this._mapStandardResponse(response);
  }

  _mapStandardResponse(response) {
    // Standardizes the native connector response into a Hyperswitch-like schema for the caller
    let mappedStatus = 'failed';
    switch(response.status) {
      case 'captured': mappedStatus = 'CHARGED'; break;
      case 'requires_action': mappedStatus = 'REQUIRES_CUSTOMER_ACTION'; break;
      case 'pending': mappedStatus = 'PROCESSING'; break;
      case 'failed': mappedStatus = 'FAILED'; break;
      case 'refund_pending': mappedStatus = 'REFUND_PENDING'; break;
      case 'refund_success': mappedStatus = 'REFUNDED'; break;
    }

    return {
      success: response.success,
      status: mappedStatus,
      connectorRef: response.connectorRef || response.captureRef || response.refundRef,
      rawResponse: response.rawResponse,
      action: response.qrCode ? { type: 'qr_code', payload: response.qrCode } : null
    };
  }
}

module.exports = PaymentClient;
