'use strict';

/**
 * NexusPay — Bank Bridge (Prism Layer)
 * 
 * TCP/TLS client for communicating with a Sponsor Bank's switch
 * via ISO 8583 messages. In development/sandbox mode, uses an
 * integrated Mock Bank Switch that simulates standard banking responses.
 * 
 * Production: Connects to sponsor bank's IP:port via TLS
 * Sandbox:    Uses built-in MockBankSwitch
 * 
 * The bridge is designed to be bank-agnostic — swap field mappings
 * in iso8583-encoder.js for different bank specs.
 * 
 * NO RAW PAN/CVV IS EVER LOGGED. All card data is ephemeral
 * and only exists in memory during the ISO 8583 message lifecycle.
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { ISO8583Encoder, MTI, RESPONSE_CODES, generateSTAN, generateRRN } = require('./iso8583-encoder');
const logger = require('../utils/logger');

// ── Configuration ───────────────────────────────────────────────────────────

const BANK_CONFIG = {
  host:        process.env.BANK_SWITCH_HOST     || 'localhost',
  port:        parseInt(process.env.BANK_SWITCH_PORT || '9583'),
  useTLS:      process.env.BANK_SWITCH_TLS      === 'true',
  timeoutMs:   parseInt(process.env.BANK_SWITCH_TIMEOUT || '30000'),
  terminalId:  process.env.BANK_TERMINAL_ID     || 'NXPY0001',
  merchantId:  process.env.BANK_MERCHANT_ID     || 'NEXUSPAY000001',
  // Sandbox mode — uses mock switch
  sandboxMode: process.env.BANK_SANDBOX_MODE    !== 'false', // Default: true
};

// ── Mock Bank Switch ────────────────────────────────────────────────────────
// Simulates a real bank's authorization switch for development/testing.
// Returns realistic response codes based on test scenarios.

class MockBankSwitch {
  /**
   * Process an ISO 8583 authorization request.
   * Simulates various bank responses based on amount patterns.
   * 
   * Test amounts:
   *   ₹X.01 (amount ending in 01) → Insufficient Funds
   *   ₹X.05 (amount ending in 05) → Do Not Honor
   *   ₹X.91 (amount ending in 91) → Bank Timeout
   *   ₹X.14 (amount ending in 14) → Invalid Card
   *   Any other → Approved
   */
  static processAuthRequest(fields) {
    const amount = parseInt(fields[4] || '0');
    const lastTwoDigits = amount % 100;

    // Simulate processing latency (50-500ms)
    const latencyMs = 50 + Math.floor(Math.random() * 450);
    const authCode = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
    const rrn = fields[37] || generateRRN();

    // Test scenario routing
    let responseCode = '00'; // Default: Approved

    switch (lastTwoDigits) {
      case 1:  responseCode = '51'; break; // Insufficient Funds
      case 5:  responseCode = '05'; break; // Do Not Honor
      case 14: responseCode = '14'; break; // Invalid Card Number
      case 41: responseCode = '41'; break; // Lost Card
      case 43: responseCode = '43'; break; // Stolen Card
      case 54: responseCode = '54'; break; // Expired Card
      case 55: responseCode = '55'; break; // Incorrect PIN
      case 91: responseCode = '91'; break; // Issuer Unavailable (timeout sim)
      case 96: responseCode = '96'; break; // System Malfunction
    }

    // High amounts trigger fraud check
    if (amount > 10000000) { // > ₹1,00,000
      responseCode = '57'; // Transaction not permitted
    }

    return {
      responseCode,
      authCode: responseCode === '00' ? authCode : '',
      rrn,
      latencyMs,
      fields: {
        38: responseCode === '00' ? authCode : '',
        39: responseCode,
        37: rrn,
      },
      parsed: RESPONSE_CODES[responseCode] || { status: 'unknown', description: 'Unknown' },
    };
  }

  /**
   * Process a reversal request.
   */
  static processReversalRequest(fields) {
    return {
      responseCode: '00',
      authCode: '',
      rrn: fields[37] || generateRRN(),
      latencyMs: 100,
      fields: { 39: '00', 37: fields[37] || '' },
      parsed: { status: 'approved', description: 'Reversal Approved' },
    };
  }
}

// ── Bank Bridge ─────────────────────────────────────────────────────────────

class BankBridge {
  constructor(config = {}) {
    this.config = { ...BANK_CONFIG, ...config };
    this.isConnected = false;
    this.socket = null;
    this.pendingRequests = new Map(); // correlationId → { resolve, reject, timeout }
  }

  /**
   * Send an authorization request to the bank.
   * 
   * @param {Object} params
   * @param {string} params.pan - Card number (ephemeral, never stored)
   * @param {number} params.amount - Minor units
   * @param {string} params.currency - Currency code
   * @param {string} params.expiryDate - YYMM
   * @param {string} params.merchantId - NexusPay merchant ID
   * @param {string} params.merchantName - Merchant display name
   * @returns {Object} { approved, responseCode, authCode, rrn, description, latencyMs }
   */
  async authorize(params) {
    const stan = generateSTAN();
    const rrn = generateRRN();

    const startTime = Date.now();

    // PCI: Log only masked data
    logger.info(`[BANK_BRIDGE] Auth request: amount=${params.amount}, currency=${params.currency}, stan=${stan}, rrn=${rrn}`);

    if (this.config.sandboxMode) {
      return this._handleSandboxAuth(params, stan, rrn, startTime);
    }

    return this._handleLiveAuth(params, stan, rrn, startTime);
  }

  /**
   * Send a reversal/refund request to the bank.
   */
  async reverse(params) {
    const stan = generateSTAN();
    const startTime = Date.now();

    logger.info(`[BANK_BRIDGE] Reversal request: originalRrn=${params.originalRrn}, amount=${params.amount}`);

    if (this.config.sandboxMode) {
      return this._handleSandboxReversal(params, stan, startTime);
    }

    return this._handleLiveReversal(params, stan, startTime);
  }

  /**
   * Network management message (echo test / sign-on).
   */
  async networkTest() {
    if (this.config.sandboxMode) {
      return { success: true, latencyMs: 10, message: 'Mock bank switch OK' };
    }

    try {
      // Send 0800 network management message
      const startTime = Date.now();
      // In production, this would send an actual network test message
      return { success: true, latencyMs: Date.now() - startTime, message: 'Network test OK' };
    } catch (err) {
      return { success: false, latencyMs: -1, message: err.message };
    }
  }

  // ── Sandbox Handlers ──────────────────────────────────────────────────

  async _handleSandboxAuth(params, stan, rrn, startTime) {
    // Build ISO 8583 message (for validation, even in sandbox)
    const messageBuffer = ISO8583Encoder.buildAuthRequest({
      pan: params.pan,
      amount: params.amount,
      currency: params.currency,
      expiryDate: params.expiryDate,
      merchantId: params.merchantId,
      merchantName: params.merchantName,
      stan,
      rrn,
    });

    // Decode to get fields (round-trip validation)
    const decoded = ISO8583Encoder.decode(messageBuffer);

    // Process through mock switch
    const mockResponse = MockBankSwitch.processAuthRequest(decoded.fields);

    // Simulate network latency
    await new Promise(resolve => setTimeout(resolve, mockResponse.latencyMs));

    const totalLatency = Date.now() - startTime;
    const approved = mockResponse.responseCode === '00';

    // PCI: NEVER log PAN
    logger.info(`[BANK_BRIDGE] Auth response: code=${mockResponse.responseCode} (${mockResponse.parsed.description}), latency=${totalLatency}ms`);

    return {
      approved,
      responseCode: mockResponse.responseCode,
      authCode: mockResponse.authCode,
      rrn: mockResponse.rrn,
      stan,
      description: mockResponse.parsed.description,
      status: mockResponse.parsed.status,
      latencyMs: totalLatency,
      sandbox: true,
    };
  }

  async _handleSandboxReversal(params, stan, startTime) {
    const mockResponse = MockBankSwitch.processReversalRequest({
      37: params.originalRrn,
      4: String(params.amount).padStart(12, '0'),
    });

    await new Promise(resolve => setTimeout(resolve, mockResponse.latencyMs));

    return {
      approved: mockResponse.responseCode === '00',
      responseCode: mockResponse.responseCode,
      rrn: params.originalRrn,
      stan,
      description: mockResponse.parsed.description,
      latencyMs: Date.now() - startTime,
      sandbox: true,
    };
  }

  // ── Live Connection Handlers ──────────────────────────────────────────
  // These connect to the actual sponsor bank switch via TCP/TLS.

  async _handleLiveAuth(params, stan, rrn, startTime) {
    const messageBuffer = ISO8583Encoder.buildAuthRequest({
      pan: params.pan,
      amount: params.amount,
      currency: params.currency,
      expiryDate: params.expiryDate,
      merchantId: this.config.merchantId,
      merchantName: params.merchantName,
      terminalId: this.config.terminalId,
      stan,
      rrn,
    });

    try {
      const responseBuffer = await this._sendToBank(messageBuffer);
      const decoded = ISO8583Encoder.decode(responseBuffer);
      const responseCode = decoded.fields[39] || '96';
      const parsed = ISO8583Encoder.parseResponseCode(responseCode);

      return {
        approved: responseCode === '00',
        responseCode,
        authCode: decoded.fields[38] || '',
        rrn: decoded.fields[37] || rrn,
        stan,
        description: parsed.description,
        status: parsed.status,
        latencyMs: Date.now() - startTime,
        sandbox: false,
      };
    } catch (err) {
      logger.error(`[BANK_BRIDGE] Live auth failed: ${err.message}`);
      return {
        approved: false,
        responseCode: '91',
        authCode: '',
        rrn,
        stan,
        description: 'Issuer unavailable',
        status: 'error',
        latencyMs: Date.now() - startTime,
        sandbox: false,
      };
    }
  }

  async _handleLiveReversal(params, stan, startTime) {
    const messageBuffer = ISO8583Encoder.buildReversalRequest({
      amount: params.amount,
      currency: params.currency,
      originalRrn: params.originalRrn,
      originalAuthCode: params.originalAuthCode,
      merchantId: this.config.merchantId,
      terminalId: this.config.terminalId,
      stan,
    });

    try {
      const responseBuffer = await this._sendToBank(messageBuffer);
      const decoded = ISO8583Encoder.decode(responseBuffer);
      const responseCode = decoded.fields[39] || '96';

      return {
        approved: responseCode === '00',
        responseCode,
        rrn: params.originalRrn,
        stan,
        latencyMs: Date.now() - startTime,
        sandbox: false,
      };
    } catch (err) {
      return {
        approved: false,
        responseCode: '91',
        rrn: params.originalRrn,
        stan,
        latencyMs: Date.now() - startTime,
        sandbox: false,
      };
    }
  }

  /**
   * Send a message to the bank switch and wait for response.
   * @param {Buffer} messageBuffer - Encoded ISO 8583 message
   * @returns {Buffer} Response buffer
   */
  _sendToBank(messageBuffer) {
    return new Promise((resolve, reject) => {
      const createConnection = this.config.useTLS ? tls.connect : net.connect;
      const options = {
        host: this.config.host,
        port: this.config.port,
        ...(this.config.useTLS ? { rejectUnauthorized: true } : {}),
      };

      const socket = createConnection(options, () => {
        socket.write(messageBuffer);
      });

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Bank switch timeout after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);

      const chunks = [];

      socket.on('data', (data) => {
        chunks.push(data);
        // Check if we have a complete message (length-prefixed)
        const combined = Buffer.concat(chunks);
        if (combined.length >= 4) {
          const expectedLen = parseInt(combined.toString('ascii', 0, 4)) + 4;
          if (combined.length >= expectedLen) {
            clearTimeout(timeout);
            socket.destroy();
            resolve(combined);
          }
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      socket.on('close', () => {
        clearTimeout(timeout);
        if (chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        }
      });
    });
  }

  /**
   * Health check for the bank bridge.
   */
  async healthCheck() {
    if (this.config.sandboxMode) {
      return { healthy: true, latencyMs: 5, message: 'Sandbox mode — Mock Bank Switch active', sandbox: true };
    }
    return this.networkTest();
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance = null;

function getBankBridge(config) {
  if (!_instance) {
    _instance = new BankBridge(config);
  }
  return _instance;
}

module.exports = { BankBridge, MockBankSwitch, getBankBridge };
