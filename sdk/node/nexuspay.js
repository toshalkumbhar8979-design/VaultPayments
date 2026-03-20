'use strict';
/**
 * NexusPay Node.js SDK v2.0
 * Zero dependencies — pure Node.js stdlib
 *
 * Usage:
 *   const NexusPay = require('./nexuspay');
 *   const vp = new NexusPay('vp_live_YOUR_KEY');
 *   const payment = await vp.payments.create({ ... });
 *   res.redirect(payment.gateway_url);
 */

const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');

const SDK_VER = '2.0.0';

class NexusPayError extends Error {
  constructor(message, code, status, raw) {
    super(message);
    this.name       = 'NexusPayError';
    this.code       = code       || 'API_ERROR';
    this.statusCode = status     || 0;
    this.raw        = raw        || null;
  }
}

class NexusPay {
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new NexusPayError('API key is required', 'MISSING_API_KEY');
    if (!/^vp_(live|test)_[a-f0-9]{32}$/.test(apiKey)) {
      throw new NexusPayError('Invalid API key format. Expected vp_live_... or vp_test_...', 'INVALID_KEY_FORMAT');
    }
    this._key      = apiKey;
    this._base     = (options.baseUrl || 'https://your-backend.railway.app/api/v1').replace(/\/$/, '');
    this._timeout  = options.timeout || 30000;
    this._isLive   = apiKey.startsWith('vp_live_');

    this.payments  = new PaymentsResource(this);
    this.qr        = new QRResource(this);
    this.sms       = new SMSResource(this);
  }

  get isLiveMode() { return this._isLive; }
  get isTestMode() { return !this._isLive; }

  async _req(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url     = new URL(`${this._base}${path}`);
      const payload = body ? JSON.stringify(body) : null;
      const lib     = url.protocol === 'https:' ? https : http;

      const opts = {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   method.toUpperCase(),
        timeout:  this._timeout,
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'application/json',
          'X-NexusPay-Key': this._key,
          'X-NexusPay-SDK': `node/${SDK_VER}`,
          'User-Agent':     `NexusPay-SDK-Node/${SDK_VER}`,
          ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
        },
      };

      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.success) {
              return reject(new NexusPayError(
                parsed.error?.message || 'API Error',
                parsed.error?.code, res.statusCode, parsed
              ));
            }
            resolve(parsed.data);
          } catch {
            reject(new NexusPayError('Failed to parse response', 'PARSE_ERROR', res.statusCode, data));
          }
        });
      });

      req.on('timeout', () => { req.destroy(); reject(new NexusPayError('Request timed out', 'TIMEOUT', 408)); });
      req.on('error',  (e) => reject(new NexusPayError(`Network error: ${e.message}`, 'NETWORK_ERROR')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Verify a NexusPay webhook signature.
   * ALWAYS call this before trusting webhook data.
   *
   * @param {Buffer|string} rawBody  — raw request body
   * @param {string}        signature — X-NexusPay-Signature header
   * @param {string}        secret   — your webhook secret
   */
  static verifyWebhookSignature(rawBody, signature, secret) {
    if (!rawBody || !signature || !secret) return false;
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
  }
}

class PaymentsResource {
  constructor(c) { this._c = c; }

  /**
   * Create a payment order.
   * Returns: { payment_id, qr_code, gateway_url, amount_formatted, expires_at, ... }
   */
  async create({ order_id, amount, currency = 'INR', customer, description = '',
    payment_method = 'qr', metadata = {}, redirect_url, callback_url, expires_in = 3600 }) {
    if (!order_id)          throw new NexusPayError('order_id is required',         'MISSING_PARAM');
    if (!amount || amount < 100) throw new NexusPayError('amount must be ≥ 100 paise','INVALID_AMOUNT');
    if (!customer?.email)   throw new NexusPayError('customer.email is required',   'MISSING_PARAM');
    if (!customer?.phone)   throw new NexusPayError('customer.phone is required',   'MISSING_PARAM');
    return this._c._req('POST', '/payments/create', {
      order_id, amount, currency, customer, description, payment_method,
      metadata, redirect_url, callback_url, expires_in,
    });
  }

  fetch(paymentId)          { return this._c._req('GET',  `/payments/${paymentId}`); }
  capture(paymentId, amt)   { return this._c._req('POST', `/payments/${paymentId}/capture`, { payment_id: paymentId, ...(amt && { amount: amt }) }); }
  refund(paymentId)         { return this._c._req('POST', `/payments/${paymentId}/refund`); }
  list(limit = 50)          { return this._c._req('GET',  `/payments?limit=${Math.min(limit,100)}`); }
}

class QRResource {
  constructor(c) { this._c = c; }
  generate(text, opts = {}) {
    return this._c._req('POST', '/qr/generate', { text, width: opts.width, dark_color: opts.darkColor });
  }
}

class SMSResource {
  constructor(c) { this._c = c; }
  parse(smsText, paymentId = null) {
    return this._c._req('POST', '/sms/parse', { sms: smsText, ...(paymentId && { payment_id: paymentId }) });
  }
}

module.exports = NexusPay;
module.exports.NexusPayError = NexusPayError;
module.exports.default = NexusPay;
