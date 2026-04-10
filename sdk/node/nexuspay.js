'use strict';
/**
 * NexusPay Node.js SDK v2.0
 * Zero dependencies — pure Node.js stdlib
 * Inspired by Hyperswitch Architecture
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
    this._key      = apiKey;
    this._base     = (options.baseUrl || 'http://localhost:5000/api/v1/payments').replace(/\/$/, '');
    this._timeout  = options.timeout || 30000;
    this._isLive   = apiKey.startsWith('vp_live_');

    this.payments  = new PaymentsResource(this);
    this.qr        = new QRResource(this);
  }

  get isLiveMode() { return this._isLive; }
  get isTestMode() { return !this._isLive; }

  async _req(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const urlPath = path.startsWith('/') ? path : `/${path}`;
      const url     = new URL(`${this._base}${urlPath === '/' ? '' : urlPath}`);
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

  static verifyWebhookSignature(rawBody, signature, secret) {
    if (!rawBody || !signature || !secret) return false;
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
  }
}

class PaymentsResource {
  constructor(c) { this._c = c; }

  async create(payload) {
    return this._c._req('POST', '/', payload);
  }

  confirm(paymentId, payload) {
    return this._c._req('POST', `/${paymentId}/confirm`, payload);
  }

  sync(paymentId) {
    return this._c._req('POST', `/${paymentId}/sync`);
  }

  fetch(paymentId)          { return this._c._req('GET',  `/${paymentId}`); }
  capture(paymentId, amt)   { return this._c._req('POST', `/${paymentId}/capture`, { payment_id: paymentId, ...(amt && { amount: amt }) }); }
  refund(paymentId)         { return this._c._req('POST', `/${paymentId}/refund`); }
  list(limit = 50)          { return this._c._req('GET',  `?limit=${Math.min(limit,100)}`); }
}

class QRResource {
  constructor(c) { this._c = c; }
  generate(text, opts = {}) {
    // QR generator is usually at /qr/generate, but we anchor BASE at /payments. 
    // We'll use a hacky relative path or update base. 
    // Better: update base to /api/v1 and prefix resources.
    return this._c._req('POST', '/api/v1/qr/generate', { text, width: opts.width, dark_color: opts.darkColor });
  }
}

module.exports = NexusPay;
module.exports.NexusPayError = NexusPayError;
module.exports.default = NexusPay;
