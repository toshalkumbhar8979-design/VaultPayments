'use strict';

/**
 * NexusPay — ISO 8583 Message Encoder/Decoder
 * 
 * Implements the ISO 8583 financial messaging standard used by
 * banking switches worldwide. This module builds and parses
 * authorization, reversal, and settlement messages.
 * 
 * Designed to be modular — field mappings can be swapped for
 * different bank specs (ICICI, Suryoday, Yes Bank, etc.).
 * 
 * Message Structure:
 *   [MTI (4 bytes)] [Primary Bitmap (16 hex)] [Secondary Bitmap (16 hex)] [Data Fields...]
 * 
 * Key Fields:
 *   DE2  — Primary Account Number (PAN)
 *   DE3  — Processing Code
 *   DE4  — Transaction Amount
 *   DE7  — Transmission Date/Time
 *   DE11 — System Trace Audit Number (STAN)
 *   DE12 — Local Transaction Time
 *   DE13 — Local Transaction Date
 *   DE14 — Expiry Date
 *   DE22 — POS Entry Mode
 *   DE25 — POS Condition Code
 *   DE37 — Retrieval Reference Number
 *   DE38 — Authorization ID Response
 *   DE39 — Response Code
 *   DE41 — Terminal ID
 *   DE42 — Merchant ID
 *   DE43 — Card Acceptor Name/Location
 *   DE48 — Additional Data
 *   DE49 — Currency Code (Transaction)
 *   DE54 — Additional Amounts
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ── MTI (Message Type Indicators) ───────────────────────────────────────────

const MTI = {
  AUTH_REQUEST:       '0100',
  AUTH_RESPONSE:      '0110',
  AUTH_ADVICE:        '0120',
  FINANCIAL_REQUEST:  '0200',
  FINANCIAL_RESPONSE: '0210',
  REVERSAL_REQUEST:   '0400',
  REVERSAL_RESPONSE:  '0410',
  NETWORK_REQUEST:    '0800',
  NETWORK_RESPONSE:   '0810',
};

// ── Field Definitions ───────────────────────────────────────────────────────
// Each field: { id, name, type, maxLength, format }
// type: 'n' (numeric), 'an' (alphanumeric), 'ans' (alphanumeric+special), 'b' (binary)
// format: 'fixed' or 'llvar' (2-digit length prefix) or 'lllvar' (3-digit length prefix)

const FIELD_DEFS = {
  2:  { name: 'PAN',                    type: 'n',   maxLen: 19, format: 'llvar' },
  3:  { name: 'ProcessingCode',         type: 'n',   maxLen: 6,  format: 'fixed' },
  4:  { name: 'TransactionAmount',      type: 'n',   maxLen: 12, format: 'fixed' },
  7:  { name: 'TransmissionDateTime',   type: 'n',   maxLen: 10, format: 'fixed' },
  11: { name: 'STAN',                   type: 'n',   maxLen: 6,  format: 'fixed' },
  12: { name: 'LocalTransactionTime',   type: 'n',   maxLen: 6,  format: 'fixed' },
  13: { name: 'LocalTransactionDate',   type: 'n',   maxLen: 4,  format: 'fixed' },
  14: { name: 'ExpiryDate',             type: 'n',   maxLen: 4,  format: 'fixed' },
  22: { name: 'POSEntryMode',           type: 'n',   maxLen: 3,  format: 'fixed' },
  25: { name: 'POSConditionCode',       type: 'n',   maxLen: 2,  format: 'fixed' },
  35: { name: 'Track2',                 type: 'an',  maxLen: 37, format: 'llvar' },
  37: { name: 'RRN',                    type: 'an',  maxLen: 12, format: 'fixed' },
  38: { name: 'AuthorizationCode',      type: 'an',  maxLen: 6,  format: 'fixed' },
  39: { name: 'ResponseCode',           type: 'an',  maxLen: 2,  format: 'fixed' },
  41: { name: 'TerminalID',             type: 'ans', maxLen: 8,  format: 'fixed' },
  42: { name: 'MerchantID',             type: 'ans', maxLen: 15, format: 'fixed' },
  43: { name: 'CardAcceptorName',       type: 'ans', maxLen: 40, format: 'fixed' },
  48: { name: 'AdditionalData',         type: 'ans', maxLen: 999,format: 'lllvar' },
  49: { name: 'CurrencyCode',           type: 'n',   maxLen: 3,  format: 'fixed' },
  54: { name: 'AdditionalAmounts',      type: 'ans', maxLen: 120,format: 'lllvar' },
  55: { name: 'EMVData',                type: 'ans', maxLen: 999,format: 'lllvar' },
  60: { name: 'PrivateUse1',            type: 'ans', maxLen: 60, format: 'lllvar' },
  63: { name: 'PrivateUse2',            type: 'ans', maxLen: 999,format: 'lllvar' },
};

// ── ISO 8583 Response Codes ─────────────────────────────────────────────────

const RESPONSE_CODES = {
  '00': { status: 'approved',           description: 'Approved' },
  '01': { status: 'refer',              description: 'Refer to card issuer' },
  '03': { status: 'declined',           description: 'Invalid merchant' },
  '05': { status: 'declined',           description: 'Do not honor' },
  '12': { status: 'declined',           description: 'Invalid transaction' },
  '13': { status: 'declined',           description: 'Invalid amount' },
  '14': { status: 'declined',           description: 'Invalid card number' },
  '30': { status: 'error',             description: 'Format error' },
  '41': { status: 'declined',           description: 'Card reported lost' },
  '43': { status: 'declined',           description: 'Card reported stolen' },
  '51': { status: 'declined',           description: 'Insufficient funds' },
  '54': { status: 'declined',           description: 'Expired card' },
  '55': { status: 'declined',           description: 'Incorrect PIN' },
  '57': { status: 'declined',           description: 'Transaction not permitted' },
  '58': { status: 'declined',           description: 'Transaction not permitted to terminal' },
  '61': { status: 'declined',           description: 'Exceeds withdrawal limit' },
  '65': { status: 'declined',           description: 'Exceeds withdrawal frequency' },
  '91': { status: 'error',             description: 'Issuer unavailable' },
  '96': { status: 'error',             description: 'System malfunction' },
};

// ── Currency Codes (ISO 4217) ───────────────────────────────────────────────

const CURRENCY_CODES = {
  'INR': '356',
  'USD': '840',
  'EUR': '978',
  'GBP': '826',
};

// ── Encoder ─────────────────────────────────────────────────────────────────

class ISO8583Encoder {
  /**
   * Build an ISO 8583 authorization request message.
   * 
   * @param {Object} params
   * @param {string} params.pan - Card number (NEVER logged or stored)
   * @param {number} params.amount - Amount in minor units (paise/cents)
   * @param {string} params.currency - Currency code (INR, USD, etc.)
   * @param {string} params.expiryDate - YYMM format
   * @param {string} params.merchantId - Merchant terminal ID
   * @param {string} params.merchantName - Merchant display name
   * @param {string} params.stan - System Trace Audit Number
   * @param {string} params.rrn - Retrieval Reference Number
   * @returns {Buffer} Encoded ISO 8583 message
   */
  static buildAuthRequest(params) {
    const now = new Date();
    const fields = {};

    // DE2 - PAN (Primary Account Number)
    // CRITICAL: This is ONLY used for message construction, NEVER logged
    fields[2] = params.pan;

    // DE3 - Processing Code (000000 = Purchase)
    fields[3] = '000000';

    // DE4 - Transaction Amount (12 digits, zero-padded)
    fields[4] = String(params.amount).padStart(12, '0');

    // DE7 - Transmission Date/Time (MMDDhhmmss)
    fields[7] = formatDateTime(now);

    // DE11 - STAN (6 digits)
    fields[11] = (params.stan || generateSTAN()).padStart(6, '0');

    // DE12 - Local Transaction Time (hhmmss)
    fields[12] = formatTime(now);

    // DE13 - Local Transaction Date (MMDD)
    fields[13] = formatDate(now);

    // DE14 - Expiry Date (YYMM)
    if (params.expiryDate) {
      fields[14] = params.expiryDate;
    }

    // DE22 - POS Entry Mode (051 = chip, 071 = contactless, 010 = manual, 812 = e-commerce)
    fields[22] = '812'; // E-commerce

    // DE25 - POS Condition Code (59 = e-commerce)
    fields[25] = '59';

    // DE37 - Retrieval Reference Number
    fields[37] = (params.rrn || generateRRN()).padEnd(12, ' ');

    // DE41 - Terminal ID
    fields[41] = (params.terminalId || 'NXPY0001').padEnd(8, ' ');

    // DE42 - Merchant ID
    fields[42] = (params.merchantId || '').slice(0, 15).padEnd(15, ' ');

    // DE43 - Card Acceptor Name/Location
    fields[43] = (params.merchantName || 'NexusPay Merchant').slice(0, 40).padEnd(40, ' ');

    // DE49 - Currency Code
    fields[49] = CURRENCY_CODES[params.currency] || '356';

    return this.encode(MTI.AUTH_REQUEST, fields);
  }

  /**
   * Build a reversal request (for voiding/refunding at bank level).
   */
  static buildReversalRequest(params) {
    const fields = {};
    fields[3]  = '000000';
    fields[4]  = String(params.amount).padStart(12, '0');
    fields[7]  = formatDateTime(new Date());
    fields[11] = (params.stan || generateSTAN()).padStart(6, '0');
    fields[37] = params.originalRrn.padEnd(12, ' ');
    fields[38] = params.originalAuthCode || '';
    fields[41] = (params.terminalId || 'NXPY0001').padEnd(8, ' ');
    fields[42] = (params.merchantId || '').slice(0, 15).padEnd(15, ' ');
    fields[49] = CURRENCY_CODES[params.currency] || '356';

    return this.encode(MTI.REVERSAL_REQUEST, fields);
  }

  /**
   * Encode fields into an ISO 8583 binary message.
   * @param {string} mti - Message Type Indicator
   * @param {Object} fields - Field number → value mapping
   * @returns {Buffer} Encoded message
   */
  static encode(mti, fields) {
    // Build bitmap
    const bitmap = new Array(128).fill(0);
    const fieldNums = Object.keys(fields).map(Number).sort((a, b) => a - b);

    // Set secondary bitmap flag if any field > 64
    const hasSecondary = fieldNums.some(n => n > 64);
    if (hasSecondary) bitmap[0] = 1;

    for (const num of fieldNums) {
      bitmap[num - 1] = 1;
    }

    // Convert bitmap to hex
    const primaryBitmapHex = bitmapToHex(bitmap.slice(0, 64));
    const secondaryBitmapHex = hasSecondary ? bitmapToHex(bitmap.slice(64, 128)) : '';

    // Encode data fields
    let dataBuffer = '';
    for (const num of fieldNums) {
      const def = FIELD_DEFS[num];
      const value = fields[num] || '';

      if (!def) {
        logger.warn(`[ISO8583] Unknown field DE${num}, skipping`);
        continue;
      }

      switch (def.format) {
        case 'fixed':
          dataBuffer += value.slice(0, def.maxLen).padEnd(def.maxLen, ' ');
          break;
        case 'llvar':
          const llLen = String(value.length).padStart(2, '0');
          dataBuffer += llLen + value;
          break;
        case 'lllvar':
          const lllLen = String(value.length).padStart(3, '0');
          dataBuffer += lllLen + value;
          break;
      }
    }

    const message = mti + primaryBitmapHex + secondaryBitmapHex + dataBuffer;

    // Length prefix (4 bytes, network byte order)
    const lengthPrefix = String(message.length).padStart(4, '0');
    
    return Buffer.from(lengthPrefix + message, 'ascii');
  }

  /**
   * Decode an ISO 8583 response message.
   * @param {Buffer} buffer - Raw message buffer
   * @returns {Object} { mti, fields }
   */
  static decode(buffer) {
    const raw = buffer.toString('ascii');
    let offset = 4; // Skip length prefix

    // MTI
    const mti = raw.substring(offset, offset + 4);
    offset += 4;

    // Primary bitmap (16 hex chars = 64 bits)
    const primaryBitmapHex = raw.substring(offset, offset + 16);
    offset += 16;
    const bitmap = hexToBitmap(primaryBitmapHex);

    // Secondary bitmap if bit 1 is set
    let fullBitmap = bitmap;
    if (bitmap[0] === 1) {
      const secondaryHex = raw.substring(offset, offset + 16);
      offset += 16;
      fullBitmap = [...bitmap, ...hexToBitmap(secondaryHex)];
    }

    // Parse data fields
    const fields = {};
    for (let i = 1; i < fullBitmap.length; i++) {
      if (fullBitmap[i] !== 1) continue;
      const fieldNum = i + 1;
      if (fieldNum === 1) continue; // Skip bitmap indicator

      const def = FIELD_DEFS[fieldNum];
      if (!def) continue;

      switch (def.format) {
        case 'fixed':
          fields[fieldNum] = raw.substring(offset, offset + def.maxLen).trim();
          offset += def.maxLen;
          break;
        case 'llvar': {
          const len = parseInt(raw.substring(offset, offset + 2));
          offset += 2;
          fields[fieldNum] = raw.substring(offset, offset + len);
          offset += len;
          break;
        }
        case 'lllvar': {
          const len = parseInt(raw.substring(offset, offset + 3));
          offset += 3;
          fields[fieldNum] = raw.substring(offset, offset + len);
          offset += len;
          break;
        }
      }
    }

    return { mti, fields };
  }

  /**
   * Parse a response code into a human-readable result.
   */
  static parseResponseCode(code) {
    return RESPONSE_CODES[code] || { status: 'unknown', description: `Unknown response code: ${code}` };
  }
}

// ── Utility Functions ───────────────────────────────────────────────────────

function formatDateTime(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${mm}${dd}${hh}${mi}${ss}`;
}

function formatTime(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}${mm}${ss}`;
}

function formatDate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}${dd}`;
}

function generateSTAN() {
  return String(Math.floor(Math.random() * 999999)).padStart(6, '0');
}

function generateRRN() {
  return crypto.randomBytes(6).toString('hex').slice(0, 12);
}

function bitmapToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nibble.toString(16).toUpperCase();
  }
  return hex;
}

function hexToBitmap(hex) {
  const bits = [];
  for (const ch of hex) {
    const nibble = parseInt(ch, 16);
    bits.push((nibble >> 3) & 1, (nibble >> 2) & 1, (nibble >> 1) & 1, nibble & 1);
  }
  return bits;
}

module.exports = {
  ISO8583Encoder,
  MTI,
  RESPONSE_CODES,
  CURRENCY_CODES,
  FIELD_DEFS,
  generateSTAN,
  generateRRN,
};
