'use strict';

/**
 * NexusPay — Intelligent Router
 * 
 * Determines the best payment connector based on:
 * 1. Merchant-defined routing rules (evaluated via DSL)
 * 2. Connector success rate metrics (fallback)
 */

const { getDb } = require('../config/database');
const { evaluateCondition } = require('./rules');
const logger = require('../utils/logger');

async function getRoutingRules(merchantId) {
  return await getDb().all(
    'SELECT * FROM routing_rules WHERE merchant_id = ? AND is_active = 1 ORDER BY priority DESC',
    [merchantId]
  );
}

async function getConnectorMetrics(merchantId) {
  // Get metrics for this merchant specifically, or overall if none
  const metrics = await getDb().all('SELECT * FROM connector_metrics WHERE merchant_id = ?', [merchantId]);
  if (metrics.length > 0) return metrics;
  return await getDb().all("SELECT * FROM connector_metrics WHERE merchant_id = ''"); // Global metrics fallback
}

async function selectBestConnector(availableConnectors, intent) {
  if (!availableConnectors || availableConnectors.length === 0) return null;

  const { merchantId } = intent;

  // 1. Evaluate Routing Rules
  try {
    const rules = await getRoutingRules(merchantId);
    for (const rule of rules) {
      let conditions = {};
      try { conditions = JSON.parse(rule.conditions); } catch (e) { /* ignore bad json */ }

      if (evaluateCondition(conditions, intent)) {
        const connector = availableConnectors.find(c => c.name === rule.connector_name);
        if (connector) {
          logger.info(`[ROUTER] Rule matched: '${rule.name}'. Routing to ${connector.name}.`);
          return connector;
        }
      }
    }
  } catch (err) {
    logger.error(`[ROUTER] Error evaluating rules:`, err);
  }

  // 2. Fallback: Health & Success Rate Routing (Highest success rate wins)
  try {
    const metrics = await getConnectorMetrics(merchantId);
    
    // Assign success rate to available connectors
    const sorted = [...availableConnectors].sort((a, b) => {
      const aMetric = metrics.find(m => m.connector_name === a.name);
      const bMetric = metrics.find(m => m.connector_name === b.name);
      
      const aRate = aMetric ? aMetric.success_rate : 50.0; // Assume 50% if unknown
      const bRate = bMetric ? bMetric.success_rate : 50.0;
      
      return bRate - aRate; // Descending
    });

    logger.info(`[ROUTER] No rule matched. Fallback to success-rate routing. Selected ${sorted[0].name}.`);
    return sorted[0];

  } catch (err) {
    logger.error(`[ROUTER] Error reading metrics fallback:`, err);
  }

  // 3. Absolute Fallback: Default exact match
  const exactMatch = availableConnectors.find(c => c.name === intent.paymentMethod);
  if (exactMatch) return exactMatch;

  return availableConnectors[0];
}

module.exports = {
  selectBestConnector,
  getRoutingRules,
  getConnectorMetrics
};
