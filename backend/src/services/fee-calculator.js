'use strict';

/**
 * NexusPay — Fee Calculator
 * 
 * Computes platform fees for every transaction based on:
 *   1. Merchant-specific rate tables (from DB)
 *   2. Default rates if no custom rate is configured
 *   3. GST calculation (18% in India)
 * 
 * Supports: percentage, flat, blended (percentage + flat cap)
 */

const logger = require('../utils/logger');

// ── Default Rate Table ──────────────────────────────────────────────────────
// Used when no merchant-specific rates are configured in the DB.

const DEFAULT_RATES = {
  card:        { rateType: 'percentage', rateValue: 2.00, flatFee: 0, minFee: 100, maxFee: 0 },
  upi:         { rateType: 'flat',       rateValue: 0,    flatFee: 0, minFee: 0,   maxFee: 0 },
  netbanking:  { rateType: 'percentage', rateValue: 1.50, flatFee: 0, minFee: 100, maxFee: 0 },
  wallet:      { rateType: 'percentage', rateValue: 2.50, flatFee: 0, minFee: 50,  maxFee: 0 },
  bank_transfer:{ rateType: 'flat',      rateValue: 0,    flatFee: 500, minFee: 0, maxFee: 0 },
  qr:          { rateType: 'flat',       rateValue: 0,    flatFee: 0, minFee: 0,   maxFee: 0 },
  // Internal processor / native acquirer
  internal_processor: { rateType: 'percentage', rateValue: 1.80, flatFee: 0, minFee: 100, maxFee: 0 },
  native_acquirer:    { rateType: 'percentage', rateValue: 1.80, flatFee: 0, minFee: 100, maxFee: 0 },
};

const DEFAULT_GST_RATE = 18.00; // 18% GST on payment gateway fees in India

/**
 * Calculate fees for a transaction.
 * 
 * @param {number} grossAmount - Total payment amount in minor units (paise)
 * @param {string} paymentMethod - Payment method identifier
 * @param {string} currency - Currency code
 * @param {Object} merchantRates - Optional custom rate from DB
 * @returns {Object} { grossAmount, feeAmount, gstOnFee, totalFee, netAmount }
 */
function calculate(grossAmount, paymentMethod = 'card', currency = 'INR', merchantRates = null) {
  const method = paymentMethod.toLowerCase();
  const rates = merchantRates || DEFAULT_RATES[method] || DEFAULT_RATES.card;

  let feeAmount = 0;

  switch (rates.rateType) {
    case 'percentage':
      feeAmount = Math.round(grossAmount * (rates.rateValue / 100));
      break;

    case 'flat':
      feeAmount = rates.flatFee || 0;
      break;

    case 'blended':
      // Percentage + flat fee, with optional cap
      feeAmount = Math.round(grossAmount * (rates.rateValue / 100)) + (rates.flatFee || 0);
      break;

    default:
      feeAmount = Math.round(grossAmount * 0.02); // Fallback 2%
  }

  // Apply min/max caps
  if (rates.minFee && feeAmount < rates.minFee) {
    feeAmount = rates.minFee;
  }
  if (rates.maxFee && feeAmount > rates.maxFee) {
    feeAmount = rates.maxFee;
  }

  // Ensure fee doesn't exceed gross amount
  if (feeAmount > grossAmount) {
    feeAmount = grossAmount;
  }

  // GST on fees
  const gstRate = rates.gstRate || DEFAULT_GST_RATE;
  const gstOnFee = Math.round(feeAmount * (gstRate / 100));

  const totalFee = feeAmount + gstOnFee;
  const netAmount = grossAmount - totalFee;

  return {
    grossAmount,
    feeAmount,
    gstOnFee,
    gstRate,
    totalFee,
    netAmount,
    rateApplied: {
      method,
      rateType: rates.rateType,
      rateValue: rates.rateValue,
      isCustom: !!merchantRates,
    },
  };
}

/**
 * Load merchant-specific rates from PostgreSQL.
 * Falls back to defaults if PG is unavailable or no rates configured.
 */
async function getMerchantRates(merchantId, paymentMethod, currency = 'INR') {
  try {
    const { query, isAvailable } = require('../config/pg.database');
    if (!isAvailable()) return null;

    const result = await query(
      `SELECT * FROM merchant_fee_rates 
       WHERE merchant_id = $1 AND payment_method = $2 AND currency = $3 AND is_active = TRUE`,
      [merchantId, paymentMethod, currency]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      rateType:  row.rate_type,
      rateValue: parseFloat(row.rate_value),
      flatFee:   parseInt(row.flat_fee) || 0,
      minFee:    parseInt(row.min_fee) || 0,
      maxFee:    parseInt(row.max_fee) || 0,
      gstRate:   parseFloat(row.gst_rate) || DEFAULT_GST_RATE,
    };
  } catch (err) {
    logger.warn(`[FEE] Failed to load merchant rates: ${err.message}`);
    return null;
  }
}

/**
 * Calculate fees with merchant-specific rates (async version).
 */
async function calculateForMerchant(grossAmount, merchantId, paymentMethod, currency = 'INR') {
  const customRates = await getMerchantRates(merchantId, paymentMethod, currency);
  return calculate(grossAmount, paymentMethod, currency, customRates);
}

module.exports = {
  calculate,
  calculateForMerchant,
  getMerchantRates,
  DEFAULT_RATES,
  DEFAULT_GST_RATE,
};
