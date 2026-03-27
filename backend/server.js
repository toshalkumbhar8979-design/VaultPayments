'use strict';

require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const compression= require('compression');
const morgan     = require('morgan');
const path       = require('path');

const { initDb }   = require('./src/config/database');
const { initVaultDb } = require('./src/vault/vault.db');
const logger       = require('./src/utils/logger');
const connectors   = require('./src/connectors');
const switchService = require('./src/services/switch.service');
const vault        = require('./src/vault/vault.service');
const { errorHandler, notFoundHandler, globalRateLimiter, securityMiddleware } = require('./src/middleware');

const app        = express();
const PORT       = process.env.PORT || 5000;
const API_BASE   = `/api/${process.env.API_VERSION || 'v1'}`;

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'","'unsafe-inline'"],
      scriptSrc:  ["'self'"],
      imgSrc:     ["'self'","data:","https:"],
    },
  },
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
const { authRoutes, paymentRoutes, merchantRoutes, smsRoutes, qrRoutes, webhookRoutes } = require('./src/routes');
const billingRoutes = require('./src/routes/billing.route');

app.use(`${API_BASE}/auth`,      authRoutes);
app.use(`${API_BASE}/payments`,  paymentRoutes);
app.use(`${API_BASE}/merchants`, merchantRoutes);
app.use(`${API_BASE}/sms`,       smsRoutes);
app.use(`${API_BASE}/qr`,        qrRoutes);
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
    await initDb();
    logger.info('✅ Database initialized');

    await initVaultDb();
    logger.info('🔐 Vault Database initialized');

    connectors.initDefaults();
    logger.info('✅ Payment connectors initialized');

    startBillingScheduler();
    logger.info('✅ Billing scheduler background job running');

    app.listen(PORT, () => {
      logger.info(`🚀 ${process.env.PLATFORM_NAME || 'NexusPay'} API listening on port ${PORT}`);
      logger.info(`   Environment: ${process.env.NODE_ENV}`);
      logger.info(`   API Base:    ${API_BASE}`);
      logger.info(`   Connectors:  ${connectors.getRegistry().map(c => c.name).join(', ')}`);
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
