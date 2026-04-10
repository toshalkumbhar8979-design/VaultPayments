'use strict';

const BaseConnector = require('./base.connector');
const { v4: uuidv4 } = require('uuid');

/**
 * NexusPay — Internal Processor Connector
 * 
 * Implements the core self-hosted processing logic for NexusPay.
 * Used for simulated transactions, high-value bank fallbacks,
 * and internal ledger-based processing.
 */

class InternalProcessorConnector extends BaseConnector {
  constructor(config = {}) {
    super('internal_processor', config);
  }

  /**
   * Unified Authorize Request
   */
  async authorize(request) {
    const { paymentId, amount, currency, paymentMethod, methodData } = request;
    
    // Simulate internal processing logic
    // We delay slightly to mimic a real gateway round-trip
    await new Promise(resolve => setTimeout(resolve, 300));

    // Fraud check (Simulated)
    if (amount > 10000000) { // ₹1 Lakh
      return {
        success: false,
        status: 'declined',
        declineCode: 'FRAUD_CHECK_FAILED',
        rawResponse: { message: 'Inherent high-value risk detected by NexusPay Euclid-Lite.' }
      };
    }

    // Success if amount is ₹1 (Testing specifically for "1rupees purchase")
    if (amount === 100) {
        return {
            success: true,
            status: 'captured',
            connectorRef: `INT-${uuidv4().replace(/-/g,'').substring(0,16)}`,
            rawResponse: { message: 'NexusPay Internal Sandbox Auto-Capture (₹1.00 Purchase).' }
        };
    }

    return {
      success: true,
      status: 'captured', // Internal processor usually captures immediately or stays authorized
      connectorRef: `INT-${uuidv4().replace(/-/g,'').substring(0,16)}`,
      rawResponse: { message: 'Authorized and Captured via NexusPay Internal Core.' }
    };
  }

  async capture(connectorRef, options = {}) {
    return { success: true, status: 'captured', connectorRef };
  }

  async refund(connectorRef, options = {}) {
    return { success: true, status: 'refunded', connectorRef: `REF-${connectorRef}` };
  }

  async getStatus(connectorRef) {
    return { success: true, status: 'captured' };
  }
}

module.exports = InternalProcessorConnector;
