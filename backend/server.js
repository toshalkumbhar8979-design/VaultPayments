'use strict';

require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const compression= require('compression');
const morgan     = require('morgan');
const path       = require('path');

const { initDb }  = require('./src/config/database');
const logger      = require('./src/utils/logger');
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
app.use(`${API_BASE}/auth`,      authRoutes);
app.use(`${API_BASE}/payments`,  paymentRoutes);
app.use(`${API_BASE}/merchants`, merchantRoutes);
app.use(`${API_BASE}/sms`,       smsRoutes);
app.use(`${API_BASE}/qr`,        qrRoutes);
app.use(`${API_BASE}/webhooks`,  webhookRoutes);

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    initDb();
    logger.info('✅ Database initialized');

    app.listen(PORT, () => {
      logger.info(`🚀 ${process.env.PLATFORM_NAME || 'NexusPay'} API listening on port ${PORT}`);
      logger.info(`   Environment: ${process.env.NODE_ENV}`);
      logger.info(`   API Base:    ${API_BASE}`);
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
