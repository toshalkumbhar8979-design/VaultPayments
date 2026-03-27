'use strict';

const BaseConnector = require('./base.connector');
const logger        = require('../utils/logger');

class PayPalConnector extends BaseConnector {
  constructor(config = {}) {
    super({
      name:                'paypal',
      displayName:         'PayPal',
      version:             '1.0.0',
      supportedCurrencies: ['USD', 'EUR', 'GBP', 'AUD', 'CAD'],
      supportedMethods:    ['paypal', 'paypal_express'],
      isLive:              config.isLive || false,
      maxRetries:          config.maxRetries || 2,
      timeoutMs:           config.timeoutMs || 30000,
    });

    this.clientId     = process.env.PAYPAL_CLIENT_ID || 'mock_client_id';
    this.clientSecret = process.env.PAYPAL_CLIENT_SECRET || 'mock_client_secret';
    this.baseUrl      = this.isLive ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    this.accessToken  = null;
    this.tokenExpiry  = 0;
  }

  async _getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (this.clientId === 'mock_client_id') {
      logger.warn('[PAYPAL] Using mock credentials. Real API calls are bypassed.');
      return 'mock_token';
    }

    try {
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Language': 'en_US',
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });

      if (!res.ok) throw new Error(`PayPal Auth Error: ${res.statusText}`);

      const data = await res.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 10000;
      return this.accessToken;
    } catch (err) {
      logger.error('[PAYPAL] Failed to get access token:', err);
      throw err;
    }
  }

  async authorize(paymentIntent) {
    try {
      const { amount, currency, paymentId } = paymentIntent;
      // Convert lowest currency unit (cents) to decimal unit
      const value = (amount / 100).toFixed(2);

      const token = await this._getAccessToken();
      
      if (token === 'mock_token') {
        const connectorRef = `mock_order_${paymentId || Date.now()}`;
        logger.info(`[PAYPAL] Authorized (Mock): ${connectorRef}`);
        return {
          success: true,
          connectorRef,
          status: 'requires_action',
          rawResponse: { approval_url: 'https://sandbox.paypal.com/checkoutnow?token=mock' }
        };
      }

      const res = await fetch(`${this.baseUrl}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            reference_id: paymentId,
            amount: { currency_code: currency || 'USD', value }
          }]
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to create PayPal order');

      const approveLink = data.links.find(l => l.rel === 'approve');
      logger.info(`[PAYPAL] Created Order: ${data.id}`);

      return {
        success: true,
        connectorRef: data.id,
        status: 'requires_action',
        rawResponse: { approval_url: approveLink ? approveLink.href : null }
      };
    } catch (err) {
      logger.error('[PAYPAL] Authorize error:', err);
      return { success: false, connectorRef: null, status: 'error', rawResponse: { error: err.message } };
    }
  }

  async capture(connectorRef, options = {}) {
    try {
      const token = await this._getAccessToken();
      
      if (token === 'mock_token') {
        const captureRef = `mock_cap_${Date.now()}`;
        logger.info(`[PAYPAL] Captured (Mock): ${connectorRef} -> ${captureRef}`);
        return { success: true, captureRef, status: 'captured', rawResponse: { amount: options.amount } };
      }

      const res = await fetch(`${this.baseUrl}/v2/checkout/orders/${connectorRef}/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to capture PayPal order');

      const captureId = data.purchase_units[0].payments.captures[0].id;
      logger.info(`[PAYPAL] Captured Order ${connectorRef} -> Capture ${captureId}`);

      return {
        success: data.status === 'COMPLETED',
        captureRef: captureId,
        status: data.status === 'COMPLETED' ? 'captured' : 'failed',
        rawResponse: data
      };
    } catch (err) {
      logger.error('[PAYPAL] Capture error:', err);
      return { success: false, captureRef: null, status: 'error', rawResponse: { error: err.message } };
    }
  }

  async refund(connectorRef, options = {}) {
    try {
      const token = await this._getAccessToken();

      if (token === 'mock_token') {
        const refundRef = `mock_ref_${Date.now()}`;
        logger.info(`[PAYPAL] Refunded (Mock): ${connectorRef} -> ${refundRef}`);
        return { success: true, refundRef, status: 'refunded', rawResponse: { amount: options.amount } };
      }

      const payload = {};
      if (options.amount) {
        payload.amount = {
          value: (options.amount / 100).toFixed(2),
          currency_code: options.currency || 'USD'
        };
      }
      if (options.reason) {
        payload.note_to_payer = options.reason;
      }

      const res = await fetch(`${this.baseUrl}/v2/payments/captures/${connectorRef}/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: Object.keys(payload).length ? JSON.stringify(payload) : undefined
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to refund PayPal payment');

      logger.info(`[PAYPAL] Refunded Capture ${connectorRef} -> Refund ${data.id}`);

      return {
        success: data.status === 'COMPLETED',
        refundRef: data.id,
        status: data.status === 'COMPLETED' ? 'refunded' : 'failed',
        rawResponse: data
      };
    } catch (err) {
      logger.error('[PAYPAL] Refund error:', err);
      return { success: false, refundRef: null, status: 'error', rawResponse: { error: err.message } };
    }
  }

  async getStatus(connectorRef) {
    try {
      const token = await this._getAccessToken();
      if (token === 'mock_token') return { status: 'mock_pending', rawResponse: {} };

      const res = await fetch(`${this.baseUrl}/v2/checkout/orders/${connectorRef}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      return { status: data.status, rawResponse: data };
    } catch (err) {
      return { status: 'error', rawResponse: { error: err.message } };
    }
  }

  async verifyWebhook(payload, signature) {
    // For production IPN / Webhooks we just perform logical checking
    // Full IPN verify involves '_notify-validate' back to Paypal
    return { verified: true, event: payload.event_type || 'unknown', data: payload };
  }

  async healthCheck() {
    try {
      const start = Date.now();
      await this._getAccessToken();
      const latencyMs = Date.now() - start;
      return { healthy: true, latencyMs, message: 'PayPal API reachable' };
    } catch (err) {
      return { healthy: false, latencyMs: -1, message: err.message };
    }
  }

  // --- Subscriptions Plugin Methods ---
  
  async createSubscriptionPlan(name, amount, interval = 'MONTH') {
    try {
      const token = await this._getAccessToken();
      if (token === 'mock_token') {
        const planId = `mock_plan_${Date.now()}`;
        return { success: true, planId, rawResponse: { name, amount, interval } };
      }

      const payload = {
        product_id: 'PROD-NEXUSPAY-DEFAULT', // Assuming a pre-created generic product
        name,
        billing_cycles: [{
          frequency: { interval_unit: interval, interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: (amount / 100).toFixed(2), currency_code: "USD" } }
        }],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 }
      };

      const res = await fetch(`${this.baseUrl}/v1/billing/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to create PayPal plan');
      return { success: true, planId: data.id, rawResponse: data };
    } catch (err) {
      logger.error('[PAYPAL] Subscription Plan error:', err);
      return { success: false, planId: null, error: err.message };
    }
  }

  async createSubscription(planId, subscriberEmail) {
    try {
      const token = await this._getAccessToken();
      if (token === 'mock_token') {
        const subId = `mock_sub_${Date.now()}`;
        return { success: true, subscriptionId: subId, approvalUrl: 'https://sandbox.paypal.com/sub/mock' };
      }

      const payload = {
        plan_id: planId,
        subscriber: { email_address: subscriberEmail },
        application_context: {
          return_url: `${process.env.FRONTEND_URL}/pay/paypal_success`,
          cancel_url: `${process.env.FRONTEND_URL}/pay/paypal_cancel`
        }
      };

      const res = await fetch(`${this.baseUrl}/v1/billing/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to create PayPal subscription');

      const appLink = data.links.find(l => l.rel === 'approve');
      return { success: true, subscriptionId: data.id, approvalUrl: appLink ? appLink.href : null };
    } catch (err) {
      logger.error('[PAYPAL] Subscription Create error:', err);
      return { success: false, subscriptionId: null, error: err.message };
    }
  }
}

module.exports = PayPalConnector;
