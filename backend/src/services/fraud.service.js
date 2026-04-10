'use strict';

/**
 * VaultPayments — Radar Fraud Analysis Engine
 * Uses heuristics and mock ML scoring to evaluate transaction risk.
 */

const { getDb } = require('../config/database');
const logger = require('../utils/logger');

const RULES = [
  { id: 'FR_001', name: 'High Amount Velocity', description: 'Flag if amount exceeds ₹50,000', threshold: 50000, score: 30 },
  { id: 'FR_002', name: 'Rapid Successive Attempts', description: 'Multiple attempts from same IP in 1 min', threshold: 3, score: 45 },
  { id: 'FR_003', name: 'Geographic Mismatch', description: 'Card country differs from IP country', score: 20 },
];

class RiskEngine {
  /**
   * Evaluate a payment transaction for fraud risk.
   * @param {Object} payment - { amount, currency, customer, metadata, ip_address }
   * @returns {Object} { score, level, action, matchingRules }
   */
  async evaluate(payment) {
    let score = 0;
    const matchingRules = [];

    // Rule 1: High Amount
    if (payment.amount > 50000) {
      score += 30;
      matchingRules.push('High Amount Velocity');
    }

    // Rule 2: Mock frequency check (Randomized for simulator)
    if (Math.random() > 0.95) {
      score += 45;
      matchingRules.push('Suspicious Velocity Pattern');
    }

    // Rule 3: Anonymous proxy (Mock)
    if (payment.metadata?.is_proxy) {
      score += 60;
      matchingRules.push('Anonymous Proxy Detected');
    }

    let level = 'normal';
    let action = 'allow';

    if (score >= 90) {
      level = 'highest';
      action = 'block';
    } else if (score >= 60) {
      level = 'elevated';
      action = 'review';
    }

    return {
      score: Math.min(score, 100),
      level,
      action,
      matchingRules,
      evaluatedAt: new Date().toISOString()
    };
  }

  async getStats(merchantId) {
    // Mock stats for the dashboard
    return {
      total_scanned: 1250,
      blocked: 12,
      flagged: 45,
      risk_distribution: {
        normal: 1193,
        elevated: 45,
        highest: 12
      }
    };
  }

  async getReviewQueue(merchantId) {
    const db = getDb();
    // Fetch payments in 'processing' or 'authorized' that were flagged as 'review'
    return await db.all(
      "SELECT id, amount, currency, customer_email, status, created_at FROM payments WHERE merchant_id = ? AND status != 'captured' ORDER BY created_at DESC LIMIT 10",
      [merchantId]
    );
  }
}

module.exports = new RiskEngine();
