'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

/**
 * Generate a secure API key.
 * Format: vp_live_<32 hex chars>  or  vp_test_<32 hex chars>
 */
const generateApiKey = (mode = 'test') => {
  const random = crypto.randomBytes(24).toString('hex').substring(0, 32);
  const key    = `vp_${mode}_${random}`;
  const prefix = key.substring(0, 16);          // used for fast DB lookup
  const hash   = bcrypt.hashSync(key, 10);      // stored in DB
  return { key, prefix, hash };
};

const isValidFormat = (key) => /^vp_(live|test)_[a-f0-9]{32}$/.test(key);
const getMode       = (key) => key.startsWith('vp_live_') ? 'live' : key.startsWith('vp_test_') ? 'test' : null;

module.exports = { generateApiKey, isValidFormat, getMode };
