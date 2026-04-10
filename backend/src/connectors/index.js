'use strict';

/**
 * NexusPay — Connector Registry
 * 
 * Central registry that manages all available payment connectors.
 * The Payment Switch uses this to discover and instantiate connectors.
 */

const UPIConnector          = require('./upi.connector');
const CardSimulatorConnector = require('./card.connector');
const BankTransferConnector  = require('./bank.connector');
const PayPalConnector        = require('./paypal.connector');
const InternalProcessorConnector = require('./internal_processor');
const NativeAcquirer         = require('./native-acquirer');
const logger                 = require('../utils/logger');

// ── Registry ────────────────────────────────────────────────────────────

const _connectors = new Map();

/**
 * Register a connector instance.
 */
function register(connector) {
  if (_connectors.has(connector.name)) {
    logger.warn(`Connector '${connector.name}' already registered — overwriting.`);
  }
  _connectors.set(connector.name, connector);
  logger.info(`✅ Connector registered: ${connector.name} (${connector.displayName})`);
}

/**
 * Get a connector by name.
 */
function getConnector(name) {
  const c = _connectors.get(name);
  if (!c) throw new Error(`Connector '${name}' not found. Available: ${listNames().join(', ')}`);
  return c;
}

/**
 * Get all registered connectors.
 */
function getAll() {
  return Array.from(_connectors.values());
}

/**
 * Get all connector names.
 */
function listNames() {
  return Array.from(_connectors.keys());
}

/**
 * Get connector info for the dashboard.
 */
function getRegistry() {
  return getAll().map(c => c.getInfo());
}

/**
 * Find connectors that support a payment method + currency.
 */
function findConnectors({ method, currency }) {
  return getAll().filter(c =>
    (!method   || c.supportsMethod(method)) &&
    (!currency || c.supportsCurrency(currency))
  );
}

/**
 * Run health checks on all connectors.
 */
async function healthCheckAll() {
  const results = {};
  for (const [name, connector] of _connectors) {
    try {
      results[name] = await connector.healthCheck();
    } catch (err) {
      results[name] = { healthy: false, latencyMs: -1, message: err.message };
    }
  }
  return results;
}

// ── Initialize Default Connectors ───────────────────────────────────────

function initDefaults() {
  // PRIMARY: NexusPay Native Processor (the PSP core)
  register(new NativeAcquirer({ isLive: process.env.NODE_ENV === 'production' }));

  // FALLBACK CONNECTORS: Used when native acquirer fails or for specific methods
  register(new UPIConnector({ isLive: process.env.NODE_ENV === 'production' }));
  register(new CardSimulatorConnector());
  register(new BankTransferConnector());
  register(new PayPalConnector({ isLive: process.env.NODE_ENV === 'production' }));
  register(new InternalProcessorConnector());

  logger.info(`🔌 ${_connectors.size} connectors initialized (Native Acquirer = PRIMARY)`);
}

module.exports = {
  register,
  getConnector,
  getAll,
  listNames,
  getRegistry,
  findConnectors,
  healthCheckAll,
  initDefaults,
};
