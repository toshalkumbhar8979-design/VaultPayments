'use strict';
const { merchants, payments, transactions } = require('../config/database');
const { sendSuccess, sendError } = require('../utils/response');

const safeMerchant = async (m) => {
  if (!m) return null;
  const { password_hash, api_key_live_hash, api_key_test_hash, api_key_live_prefix,
    api_key_test_prefix, webhook_secret, ...safe } = m;
  return safe;
};

// GET /merchants/me
const getProfile = async (req, res) => {
  const m = await merchants.findById(req.merchantId);
  return sendSuccess(res, 200, 'Profile', safeMerchant(m));
};

// PUT /merchants/me
const updateProfile = async (req, res) => {
  const allowed = ['business_name','phone','website','logo_url','brand_color','webhook_url', 'upi_id'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return sendError(res, 400, 'No valid fields to update');
  const updated = await merchants.update(req.merchantId, updates);
  return sendSuccess(res, 200, 'Profile updated', await safeMerchant(updated));
};

// POST /merchants/verify-upi
const verifyUPI = async (req, res) => {
  try {
    const m = await merchants.findById(req.merchantId);
    if (!m.upi_id) return sendError(res, 400, 'Please set your UPI ID first');

    // Simulation: Send verification SMS
    logger.info(`[UPI_VERIFY] Sending verification request to UPI ${m.upi_id} for merchant ${m.id}`);

    // Auto-verify for simulation after a "successful" message send
    const updated = await merchants.update(m.id, { upi_verified: 1 });
    
    return sendSuccess(res, 200, 'UPI Verified Successfully', await safeMerchant(updated));
  } catch (err) {
    logger.error('UPI Verify error:', err);
    return sendError(res, 500, 'Verification failed');
  }
};

// GET /merchants/dashboard
const getDashboard = async (req, res) => {
  const stats   = await payments.stats(req.merchantId);
  const fees    = await transactions.totalFees(req.merchantId);
  const recent  = await payments.listByMerchant(req.merchantId, 10);
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

module.exports = { getProfile, updateProfile, getDashboard, verifyUPI };
