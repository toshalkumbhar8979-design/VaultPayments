'use strict';

/**
 * VaultPayments — Radar Fraud Controller
 * API for fraud signals, rule scanning, and manual reviews.
 */

const fraudService = require('../services/fraud.service');
const { sendSuccess, sendError }   = require('../utils/response');
const logger = require('../utils/logger');

const getFraudStats = async (req, res) => {
  try {
    const stats = await fraudService.getStats(req.merchantId);
    return sendSuccess(res, 200, 'Fraud stats', stats);
  } catch (err) {
    logger.error('[FRAUD] Stats failed:', err);
    return sendError(res, 500, 'Stats failed');
  }
};

const getReviewQueue = async (req, res) => {
  try {
    const queue = await fraudService.getReviewQueue(req.merchantId);
    return sendSuccess(res, 200, 'Review queue', { payments: queue });
  } catch (err) {
    logger.error('[FRAUD] Queue failed:', err);
    return sendError(res, 500, 'Queue failed');
  }
};

const updateRule = async (req, res) => {
  // Simulator: mocking rule updates
  return sendSuccess(res, 200, 'Rule updated');
};

const evaluatePayment = async (req, res) => {
  try {
    const { payment } = req.body;
    const result = await fraudService.evaluate(payment);
    return sendSuccess(res, 200, 'Payment evaluated', result);
  } catch (err) {
    logger.error('[FRAUD] Evaluation failed:', err);
    return sendError(res, 500, 'Evaluation failed');
  }
};

module.exports = { getFraudStats, getReviewQueue, updateRule, evaluatePayment };
