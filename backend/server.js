'use strict';

require('dotenv').config({ override: true });

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const compression= require('compression');
const morgan     = require('morgan');
const path       = require('path');

const { initDb }   = require('./src/config/database');
const { initVaultDb } = require('./src/vault/vault.db');
const { initPgPool, query: pgQuery, isAvailable: pgAvailable } = require('./src/config/pg.database');
const logger       = require('./src/utils/logger');
const connectors   = require('./src/connectors');
const switchService = require('./src/services/switch.service');
const vault        = require('./src/vault/vault.service');
const ledgerService = require('./src/ledger/ledger.service');
const { PaymentStateMachine } = require('./src/engine/state-machine');
const WebhookDispatcher = require('./src/services/webhook-dispatcher');
const { createIdempotencyMiddleware, cleanupExpiredKeys } = require('./src/middleware/idempotency.middleware');
const { errorHandler, notFoundHandler, globalRateLimiter, securityMiddleware } = require('./src/middleware');

const app        = express();
const PORT       = process.env.PORT || 5000;
const API_BASE   = `/api/${process.env.API_VERSION || 'v1'}`;

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for demo to allow inline handlers
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:4000',
  'http://localhost:5000',
  'http://127.0.0.1:5500',  // VS Code Live Server
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin (no origin header) + listed origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    // In development allow all
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods:          ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders:   ['Content-Type','Authorization','X-NexusPay-Key','X-NexusPay-Signature'],
  credentials:      true,
  maxAge:           86400,
}));

// ─── Static Files ────────────────────────────────────────────────────────────
// Serve the entire project root as static files (Landing, Dashboard, Pay UI)
app.use(express.static(path.join(__dirname, '..')));

// ─── Body Parsing ────────────────────────────────────────────────────────────
// Raw body for webhook signature verification BEFORE json parser
app.use(`${API_BASE}/webhooks`, express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(compression());
app.use(morgan('combined', {
  stream: { write: msg => logger.http(msg.trim()) },
  skip:   req => req.url === '/health',
}));
app.use(securityMiddleware);
app.use(globalRateLimiter);

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: `${process.env.PLATFORM_NAME || 'NexusPay'} API`,
  version: process.env.API_VERSION || 'v1',
  timestamp: new Date().toISOString(),
  uptime: Math.floor(process.uptime()),
}));

// ─── API Routes ───────────────────────────────────────────────────────────────
const { authRoutes, paymentRoutes, merchantRoutes, qrRoutes, webhookRoutes, routingRoutes, fraudRoutes } = require('./src/routes');
const billingRoutes = require('./src/routes/billing.route');

app.use(`${API_BASE}/auth`,      authRoutes);
app.use(`${API_BASE}/payments`,  paymentRoutes);
app.use(`${API_BASE}/merchants`, merchantRoutes);

app.use(`${API_BASE}/qr`,        qrRoutes);
app.use(`${API_BASE}/routing`,  routingRoutes);
app.use(`${API_BASE}/fraud`,    fraudRoutes);
app.use(`${API_BASE}/webhooks`,  webhookRoutes);
app.use(`${API_BASE}/billing`,   billingRoutes);

// ─── Platform API Routes (Switch, Connectors, Vault) ──────────────────────
app.get(`${API_BASE}/platform/connectors`, (req, res) => {
  res.json({ success: true, data: { connectors: connectors.getRegistry() } });
});

app.get(`${API_BASE}/platform/connectors/health`, async (req, res) => {
  const health = await connectors.healthCheckAll();
  res.json({ success: true, data: { health } });
});

app.get(`${API_BASE}/platform/switch/metrics`, (req, res) => {
  res.json({ success: true, data: { metrics: switchService.getMetrics() } });
});

app.post(`${API_BASE}/platform/vault/tokenize`, async (req, res) => {
  try {
    const result = await vault.tokenize(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

app.get(`${API_BASE}/platform/vault/tokens/:token`, async (req, res) => {
  const info = await vault.getTokenInfo(req.params.token);
  if (!info) return res.status(404).json({ success: false, error: { message: 'Token not found' } });
  res.json({ success: true, data: info });
});

app.delete(`${API_BASE}/platform/vault/tokens/:token`, async (req, res) => {
  await vault.deleteToken(req.params.token);
  res.json({ success: true, message: 'Token deleted' });
});

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

const { startBillingScheduler } = require('./src/services/billing.service');

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    // 1. SQLite (config, merchants, payments metadata)
    await initDb();
    logger.info('✅ SQLite database initialized (config/metadata)');

    // 2. Vault DB (PCI-isolated, card tokens)
    await initVaultDb();
    logger.info('🔐 Vault Database initialized (PCI-isolated)');

    // 3. PostgreSQL Ledger (ACID financial data)
    const pgPool = await initPgPool();
    if (pgPool) {
      // Run ledger schema migration
      const fs = require('fs');
      const path = require('path');
      const schemaPath = path.join(__dirname, 'src/ledger/schema/ledger_schema.sql');
      if (fs.existsSync(schemaPath)) {
        try {
          const schema = fs.readFileSync(schemaPath, 'utf-8');
          await pgPool.query(schema);
          logger.info('📒 Ledger schema applied to PostgreSQL');
        } catch (schemaErr) {
          logger.warn(`📒 Ledger schema warning (may already exist): ${schemaErr.message.split('\n')[0]}`);
        }
      }
      logger.info('🐘 PostgreSQL Ledger initialized (ACID)');

      // Initialize idempotency middleware
      const idempotencyMiddleware = createIdempotencyMiddleware({ pgQuery, isAvailable: pgAvailable });
      app.use(idempotencyMiddleware);
      logger.info('🔑 Idempotency middleware active');

      // Periodic cleanup of expired idempotency keys
      setInterval(() => cleanupExpiredKeys(pgQuery).catch(() => {}), 60 * 60 * 1000); // Every hour
    } else {
      logger.warn('⚠️  PostgreSQL not available — ledger operates in sandbox/memory mode');
    }

    // 4. Initialize Webhook Dispatcher
    const { merchants } = require('./src/config/database');
    const webhookDispatcher = new WebhookDispatcher({
      pgQuery,
      isAvailable: pgAvailable,
      merchantsDb: merchants,
    });
    logger.info('📤 Webhook Dispatcher initialized');

    // 5. Initialize State Machine
    const { getDb } = require('./src/config/database');
    const stateMachine = new PaymentStateMachine({
      db: getDb(),
      ledgerService,
      webhookDispatcher,
      pgQuery: pgAvailable() ? pgQuery : null,
    });
    logger.info('⚙️  Transaction State Machine initialized');

    // Store on app for route access
    app.locals.ledgerService = ledgerService;
    app.locals.stateMachine = stateMachine;
    app.locals.webhookDispatcher = webhookDispatcher;

    // 6. Payment Connectors (NativeAcquirer = PRIMARY)
    connectors.initDefaults();
    logger.info('✅ Payment connectors initialized');

    // 7. Billing scheduler
    startBillingScheduler();
    logger.info('✅ Billing scheduler background job running');

    // ── Ledger API Routes ──
    app.get(`${API_BASE}/ledger/balance/:merchantId`, async (req, res) => {
      try {
        const balance = await ledgerService.getMerchantBalance(req.params.merchantId);
        res.json({ success: true, data: balance });
      } catch (err) {
        res.status(500).json({ success: false, error: { message: err.message } });
      }
    });

    app.get(`${API_BASE}/ledger/entries/:paymentId`, async (req, res) => {
      try {
        const entries = await ledgerService.getPaymentEntries(req.params.paymentId);
        res.json({ success: true, data: { entries } });
      } catch (err) {
        res.status(500).json({ success: false, error: { message: err.message } });
      }
    });

    app.listen(PORT, () => {
      logger.info(`🚀 ${process.env.PLATFORM_NAME || 'NexusPay'} PSP API listening on port ${PORT}`);
      logger.info(`   Mode:        PRIMARY PAYMENT PROCESSOR`);
      logger.info(`   Environment: ${process.env.NODE_ENV}`);
      logger.info(`   API Base:    ${API_BASE}`);
      logger.info(`   Connectors:  ${connectors.getRegistry().map(c => c.name).join(', ')}`);
      logger.info(`   PostgreSQL:  ${pgAvailable() ? '✅ Connected' : '⚠️  Sandbox mode'}`);
      logger.info(`   Frontend:    ${process.env.FRONTEND_URL || 'not set'}`);
    });
  } catch (err) {
    logger.error('❌ Failed to start:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { logger.info('Graceful shutdown'); process.exit(0); });
process.on('unhandledRejection', (r) => { logger.error('Unhandled rejection:', r); });

start();
module.exports = app;
