'use strict';
const { merchants, payments, transactions } = require('../config/database');
const { sendSuccess, sendError } = require('../utils/response');

const safeMerchant = (m) => {
  if (!m) return null;
  const { password_hash, api_key_live_hash, api_key_test_hash, api_key_live_prefix,
    api_key_test_prefix, webhook_secret, ...safe } = m;
  return safe;
};

// GET /merchants/me
const getProfile = (req, res) => {
  const m = merchants.findById(req.merchantId);
  return sendSuccess(res, 200, 'Profile', safeMerchant(m));
};

// PUT /merchants/me
const updateProfile = (req, res) => {
  const allowed = ['business_name','phone','website','logo_url','brand_color','webhook_url'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return sendError(res, 400, 'No valid fields to update');
  const updated = merchants.update(req.merchantId, updates);
  return sendSuccess(res, 200, 'Profile updated', safeMerchant(updated));
};

// GET /merchants/dashboard
const getDashboard = (req, res) => {
  const stats   = payments.stats(req.merchantId);
  const fees    = transactions.totalFees(req.merchantId);
  const recent  = payments.listByMerchant(req.merchantId, 10);
  return sendSuccess(res, 200, 'Dashboard', {
    stats: {
      total_payments: stats.total_payments || 0,
      captured:       stats.captured       || 0,
      pending:        stats.pending        || 0,
      failed:         stats.failed         || 0,
      total_volume:   stats.total_volume   || 0,
      total_fees:     fees,
      net_volume:     (stats.total_volume || 0) - fees,
    },
    recent_payments: recent,
  });
};

module.exports = { getProfile, updateProfile, getDashboard };
