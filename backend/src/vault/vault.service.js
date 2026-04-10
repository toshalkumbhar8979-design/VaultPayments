'use strict';

/**
 * NexusPay — Token Vault Service (PCI DSS Compliant)
 */

const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger  = require('../utils/logger');
const pciLogger = require('../utils/pci-audit.logger');
const { tokens } = require('./vault.db');

// ── Key Derivation ─────────────────────────────────────────────────────
const VAULT_MASTER_KEY = process.env.VAULT_MASTER_KEY || crypto.randomBytes(32).toString('hex');
const KEY_INFO         = 'nexuspay-vault-v1';

function deriveKey(purpose = 'encrypt') {
  const masterBuf = Buffer.from(VAULT_MASTER_KEY, 'hex');
  return crypto.hkdfSync('sha256', masterBuf, Buffer.alloc(0), `${KEY_INFO}:${purpose}`, 32);
}

// ── Encryption / Decryption ────────────────────────────────────────────
function encrypt(plaintext) {
  const key    = deriveKey('encrypt');
  const nonce  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  return Buffer.concat([nonce, authTag, encrypted]).toString('base64');
}

function decrypt(packed) {
  const key  = deriveKey('encrypt');
  const buf  = Buffer.from(packed, 'base64');

  const nonce      = buf.subarray(0, 12);
  const authTag    = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
}

// ── Prohibited Fields (PCI DSS) ───────────────────────────────────────
const PROHIBITED_FIELDS = ['cvv', 'cvv2', 'cvc', 'pin', 'track_data', 'magnetic_stripe'];

function validateNoProhibited(data) {
  for (const field of PROHIBITED_FIELDS) {
    if (data[field] !== undefined) {
      throw new Error(`PCI VIOLATION: Cannot store prohibited field '${field}' in vault`);
    }
  }
}

// ── Tokenizer ─────────────────────────────────────────────────────────

async function tokenize(sensitiveData, context = {}) {
  validateNoProhibited(sensitiveData);

  const token = `tok_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
  const { cardNumber, cardholderName, expiryMonth, expiryYear } = sensitiveData;

  const cleanNum = (cardNumber || '').replace(/\D/g, '');
  const last4    = cleanNum.slice(-4);
  const first6   = cleanNum.slice(0, 6);
  const masked   = `${first6}${'*'.repeat(cleanNum.length - 10)}${last4}`;
  const brand    = detectCardBrand(cleanNum);

  const payload   = JSON.stringify({ cardNumber: cleanNum, cardholderName, expiryMonth, expiryYear });
  const encrypted = encrypt(payload);

  const data = {
    token,
    encrypted,
    brand,
    last4,
    masked,
    expiryMonth,
    expiryYear,
    createdAt: new Date().toISOString()
  };

  await tokens.insert(data);

  pciLogger.logAccess(context.userId, 'vault_tokens', 'tokenize', 'success', { token, brand });
  logger.info(`[VAULT] Tokenized: ${token} | ${brand} •••• ${last4}`);

  return { token, maskedCard: masked, cardBrand: brand, last4, expiryMonth, expiryYear };
}

async function detokenize(token, context = {}) {
  const entry = await tokens.find(token);
  if (!entry) {
    pciLogger.logAccess(context.userId, 'vault_tokens', 'detokenize', 'failure_not_found', { token });
    throw new Error(`Token '${token}' not found in vault`);
  }

  const decrypted = decrypt(entry.encrypted);
  const data      = JSON.parse(decrypted);

  // CRITICAL: Dedicated non-repudiable audit logging for accessing PCI clear-text data
  pciLogger.logAccess(context.userId, 'vault_tokens', 'detokenize', 'success', { token });
  
  logger.info(`[VAULT] Detokenized: ${token} (secure PCI audit logged)`);

  return data;
}

async function getTokenInfo(token) {
  const entry = await tokens.find(token);
  if (!entry) return null;

  return {
    token: entry.token,
    cardBrand: entry.brand,
    last4: entry.last4,
    maskedCard: entry.masked,
    expiryMonth: entry.expiryMonth,
    expiryYear: entry.expiryYear,
    createdAt: entry.created_at,
  };
}

async function deleteToken(token, context = {}) {
  const deleted = await tokens.delete(token);
  if (deleted) {
    pciLogger.logAccess(context.userId, 'vault_tokens', 'delete', 'success', { token });
    logger.info(`[VAULT] Deleted token: ${token}`);
  }
  return deleted;
}

async function listTokens(context = {}) {
  pciLogger.logAccess(context.userId, 'vault_tokens', 'list', 'success');
  return await tokens.listAll();
}

/**
 * Orchestration: Securely store connector credentials
 */
async function storeCredentials(merchantId, connectorName, credentials, context = {}) {
  try {
    const { merchant_credentials } = require('./vault.db');
    const encryptedCreds = encrypt(JSON.stringify(credentials));
    const now = new Date().toISOString();

    await merchant_credentials.upsert({
      merchant_id: merchantId,
      connector_name: connectorName,
      credentials_encrypted: encryptedCreds,
      updated_at: now
    });

    pciLogger.logAccess(context.userId, 'merchant_credentials', 'store', 'success', { connectorName });
    return true;
  } catch (err) {
    logger.error(`[VAULT] Credential storage failed: ${err.message}`);
    throw err;
  }
}

/**
 * Orchestration: Securely retrieve connector credentials
 */
async function getCredentials(merchantId, connectorName, context = {}) {
  try {
    const { merchant_credentials } = require('./vault.db');
    const row = await merchant_credentials.find(merchantId, connectorName);
    if (!row) return null;

    pciLogger.logAccess(context.userId, 'merchant_credentials', 'retrieve', 'success', { connectorName });
    return JSON.parse(decrypt(row.credentials_encrypted));
  } catch (err) {
    logger.error(`[VAULT] Credential retrieval failed: ${err.message}`);
    return null;
  }
}

function detectCardBrand(num) {
  if (/^4/.test(num)) return 'visa';
  if (/^5[1-5]/.test(num)) return 'mastercard';
  if (/^3[47]/.test(num)) return 'amex';
  if (/^6(?:011|5)/.test(num)) return 'discover';
  if (/^35(?:2[89]|[3-8])/.test(num)) return 'jcb';
  if (/^3(?:0[0-5]|[68])/.test(num)) return 'diners';
  if (/^62/.test(num)) return 'unionpay';
  return 'unknown';
}

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

module.exports = {
  tokenize,
  detokenize,
  getTokenInfo,
  deleteToken,
  listTokens,
  encrypt,
  decrypt,
  isValidLuhn,
  detectCardBrand,
  storeCredentials,
  getCredentials,
};
