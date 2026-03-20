'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { merchants }  = require('../config/database');
const { generateApiKey } = require('../utils/apiKey');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');
const crypto = require('crypto');

function issueToken(merchantId, email) {
  return jwt.sign(
    { merchantId, email, iat: Math.floor(Date.now()/1000) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d', algorithm: 'HS256' }
  );
}

function safeMerchant(m) {
  if (!m) return null;
  const { password_hash, api_key_live_hash, api_key_test_hash, api_key_live_prefix, api_key_test_prefix, webhook_secret, ...safe } = m;
  return safe;
}

// POST /auth/register
const register = async (req, res) => {
  try {
    const {
      name, email, phone, password,
      business_name, business_type, website, country,
      gst_number, brand_color, logo_url,
    } = req.body;

    // Duplicate check
    if (await merchants.findByEmail(email)) {
      return sendError(res, 409, 'An account with this email already exists', 'DUPLICATE_EMAIL');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const { key: liveKey, prefix: livePrefix, hash: liveHash } = generateApiKey('live');
    const { key: testKey, prefix: testPrefix, hash: testHash } = generateApiKey('test');
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();

    const merchant = await merchants.create({
      id:                   uuidv4(),
      name:                 name.trim(),
      email:                email.toLowerCase().trim(),
      phone:                phone.trim(),
      password_hash:        passwordHash,
      business_name:        business_name.trim(),
      business_type:        business_type || 'other',
      website:              website?.trim() || '',
      country:              country || 'IN',
      gst_number:           gst_number?.trim() || '',
      brand_color:          brand_color || '#5b4fff',
      logo_url:             logo_url?.trim() || '',
      webhook_url:          '',
      api_key_live_hash:    liveHash,
      api_key_live_prefix:  livePrefix,
      api_key_test_hash:    testHash,
      api_key_test_prefix:  testPrefix,
      webhook_secret:       webhookSecret,
      status:               'active',
      kyc_verified:         0,
      created_at:           now,
      updated_at:           now,
    });

    logger.info(`New merchant registered: ${merchant.id} (${email})`);

    return sendSuccess(res, 201, 'Account created successfully', {
      token:           issueToken(merchant.id, merchant.email),
      merchant:        safeMerchant(merchant),
      api_keys: {
        test:  testKey,
        live:  liveKey,
        note:  'Save your live key securely — it will not be shown again.',
      },
      webhook_secret: webhookSecret,
    });
  } catch (err) {
    logger.error('Register error:', err);
    return sendError(res, 500, 'Registration failed');
  }
};

// POST /auth/login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const merchant = await merchants.findByEmail(email.toLowerCase().trim());

    // Same message for both cases to prevent user enumeration
    const invalid = () => sendError(res, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');

    if (!merchant) return invalid();

    const match = await bcrypt.compare(password, merchant.password_hash);
    if (!match) return invalid();

    if (merchant.status !== 'active') {
      return sendError(res, 403, 'Account suspended. Contact support.', 'ACCOUNT_SUSPENDED');
    }

    logger.info(`Login: ${merchant.id}`);

    return sendSuccess(res, 200, 'Login successful', {
      token:    issueToken(merchant.id, merchant.email),
      merchant: safeMerchant(merchant),
    });
  } catch (err) {
    logger.error('Login error:', err);
    return sendError(res, 500, 'Login failed');
  }
};

// POST /auth/rotate-keys
const rotateKeys = async (req, res) => {
  try {
    const { merchantId } = req;
    const { type = 'both' } = req.body;
    const updates = {};

    if (['live','both'].includes(type)) {
      const { key, prefix, hash } = generateApiKey('live');
      updates.api_key_live_hash   = hash;
      updates.api_key_live_prefix = prefix;
      updates._new_live = key;
    }
    if (['test','both'].includes(type)) {
      const { key, prefix, hash } = generateApiKey('test');
      updates.api_key_test_hash   = hash;
      updates.api_key_test_prefix = prefix;
      updates._new_test = key;
    }

    await merchants.update(merchantId, {
      ...(updates.api_key_live_hash   && { api_key_live_hash:   updates.api_key_live_hash }),
      ...(updates.api_key_live_prefix && { api_key_live_prefix: updates.api_key_live_prefix }),
      ...(updates.api_key_test_hash   && { api_key_test_hash:   updates.api_key_test_hash }),
      ...(updates.api_key_test_prefix && { api_key_test_prefix: updates.api_key_test_prefix }),
    });

    logger.info(`Keys rotated for: ${merchantId}`);

    return sendSuccess(res, 200, 'Keys rotated. Update your integration immediately.', {
      ...(updates._new_live && { live_key: updates._new_live }),
      ...(updates._new_test && { test_key: updates._new_test }),
    });
  } catch (err) {
    logger.error('Key rotation error:', err);
    return sendError(res, 500, 'Key rotation failed');
  }
};

// POST /auth/forgot-password (placeholder — send reset email)
const forgotPassword = async (req, res) => {
  // Always return success to prevent email enumeration
  return sendSuccess(res, 200, 'If an account exists, a reset link has been sent.');
};

module.exports = { register, login, rotateKeys, forgotPassword };
