'use strict';
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { merchants } = require('../config/database');
const { sendError }  = require('../utils/response');
const logger         = require('../utils/logger');

/**
 * JWT auth — for merchant dashboard routes
 */
const authenticateJWT = (req, res, next) => {
  try {
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) {
      return sendError(res, 401, 'Authorization token required', 'UNAUTHORIZED');
    }
    const decoded  = jwt.verify(auth.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const merchant = merchants.findById(decoded.merchantId);
    if (!merchant) return sendError(res, 401, 'Account not found', 'UNAUTHORIZED');
    if (merchant.status !== 'active') return sendError(res, 403, 'Account suspended', 'FORBIDDEN');
    req.merchant   = merchant;
    req.merchantId = merchant.id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')  return sendError(res, 401, 'Token expired', 'TOKEN_EXPIRED');
    if (err.name === 'JsonWebTokenError') return sendError(res, 401, 'Invalid token', 'TOKEN_INVALID');
    return sendError(res, 500, 'Auth failed');
  }
};

/**
 * API Key auth — for server-to-server payment API calls
 * Keys: vp_live_XXXXXXXX...  or  vp_test_XXXXXXXX...
 */
const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-vaultpay-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
    if (!apiKey) return sendError(res, 401, 'API key required. Use X-VaultPay-Key header.', 'UNAUTHORIZED');
    if (!/^vp_(live|test)_[a-f0-9]{32}$/.test(apiKey)) {
      return sendError(res, 401, 'Invalid API key format', 'UNAUTHORIZED');
    }

    const prefix   = apiKey.substring(0, 16);
    const merchant = merchants.findByKeyPrefix(prefix);
    if (!merchant) return sendError(res, 401, 'Invalid API key', 'UNAUTHORIZED');
    if (merchant.status !== 'active') return sendError(res, 403, 'Account suspended', 'FORBIDDEN');

    const isLive   = apiKey.startsWith('vp_live_');
    const storedHash = isLive ? merchant.api_key_live_hash : merchant.api_key_test_hash;
    const valid    = await bcrypt.compare(apiKey, storedHash);
    if (!valid) {
      logger.warn(`Invalid API key attempt for prefix: ${prefix}`);
      return sendError(res, 401, 'Invalid API key', 'UNAUTHORIZED');
    }

    req.merchant   = merchant;
    req.merchantId = merchant.id;
    req.isLiveMode = isLive;
    next();
  } catch (err) {
    logger.error('API key auth error:', err);
    return sendError(res, 500, 'Auth failed');
  }
};

/**
 * Webhook signature verification — HMAC-SHA256
 */
const verifyWebhookSignature = (req, res, next) => {
  try {
    const sig     = req.headers['x-vaultpay-signature'] || '';
    const payload = req.body; // raw Buffer (set by express.raw in server.js)
    const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(payload).digest('hex');
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      logger.warn('Invalid webhook signature');
      return sendError(res, 401, 'Invalid webhook signature');
    }
    req.body = JSON.parse(payload.toString());
    next();
  } catch {
    return sendError(res, 400, 'Webhook verification failed');
  }
};

module.exports = { authenticateJWT, authenticateApiKey, verifyWebhookSignature };
