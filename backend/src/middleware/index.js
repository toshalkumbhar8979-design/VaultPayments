'use strict';
// ─── security.middleware.js ───────────────────────────────────────────────────
const xss    = require('xss');
const logger = require('../utils/logger');

const sanitize = (v) => {
  if (typeof v === 'string') return xss(v);
  if (Array.isArray(v))      return v.map(sanitize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, sanitize(val)]));
  return v;
};

const SQL_RE = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b/i;

const securityMiddleware = (req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Powered-By', process.env.PLATFORM_NAME || 'NexusPay');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  if (req.body)   req.body   = sanitize(req.body);
  if (req.query)  req.query  = sanitize(req.query);
  if (req.params) req.params = sanitize(req.params);

  const all = JSON.stringify({ ...req.body, ...req.query, ...req.params });
  if (SQL_RE.test(all)) {
    logger.warn(`SQL injection attempt from ${req.ip}`);
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid request' } });
  }
  next();
};

// ─── rateLimit.middleware.js ──────────────────────────────────────────────────
const rateLimit = require('express-rate-limit');

const mkLimiter = (opts) => rateLimit({
  windowMs:        opts.windowMs || 15 * 60 * 1000,
  max:             opts.max      || 200,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.headers['x-nexuspay-key'] || req.ip,
  handler:         (req, res) => res.status(429).json({
    success: false,
    error:   { code: 'RATE_LIMIT_EXCEEDED', message: opts.message || 'Too many requests. Please slow down.' },
  }),
  skip: (req) => req.url === '/health',
});

const globalRateLimiter = mkLimiter({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)        || 200,
});
const authRateLimiter    = mkLimiter({ windowMs: 900000, max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10, message: 'Too many auth attempts.' });
const paymentRateLimiter = mkLimiter({ windowMs: 60000,  max: 30 });
const smsRateLimiter     = mkLimiter({ windowMs: 60000,  max: 20 });

// ─── validation.middleware.js ─────────────────────────────────────────────────
const Joi = require('joi');

const validate = (schema, prop = 'body') => (req, res, next) => {
  const { error, value } = schema.validate(req[prop], { abortEarly: false, stripUnknown: true });
  if (error) {
    return res.status(400).json({
      success: false,
      error: {
        code:    'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.details.map(d => ({ field: d.path.join('.'), message: d.message.replace(/['"]/g,'') })),
      },
    });
  }
  req[prop] = value;
  next();
};

const schemas = {
  register: Joi.object({
    name:          Joi.string().min(2).max(80).required(),
    email:         Joi.string().email().lowercase().required(),
    phone:         Joi.string().min(7).max(16).required(),
    password:      Joi.string().min(8).pattern(/^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&&#])/).required()
                   .messages({ 'string.pattern.base': 'Password needs uppercase, number, special char' }),
    business_name: Joi.string().min(2).max(100).required(),
    business_type: Joi.string().valid('ecommerce','saas','services','food','education','healthcare','retail','events','other').default('other'),
    website:       Joi.string().required(),
    country:       Joi.string().length(2).uppercase().default('IN'),
    gst_number:    Joi.string().max(20).optional().allow(''),
    brand_color:   Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).default('#5b4fff'),
    logo_url:      Joi.string().optional().allow(''),
    upi_id:        Joi.string().optional().allow(''),
  }),
  login: Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required(),
  }),
  createPayment: Joi.object({
    order_id:      Joi.string().min(1).max(100).required(),
    amount:        Joi.number().integer().min(100).required(),
    currency:      Joi.string().valid('INR','USD','EUR','GBP','AED').default('INR'),
    customer:      Joi.object({
      name:  Joi.string().min(1).max(100).required(),
      email: Joi.string().email().required(),
      phone: Joi.string().min(10).max(16).required(),
    }).required(),
    description:   Joi.string().allow('').max(500).default(''),
    payment_method:Joi.string().valid('upi','card','net_banking','wallet','qr').default('qr'),
    metadata:      Joi.object().max(20).default({}),
    callback_url:  Joi.string().optional().allow(''),
    redirect_url:  Joi.string().optional().allow(''),
    expires_in:    Joi.number().integer().min(300).max(86400).default(3600),
  }),
  updateMerchant: Joi.object({
    business_name: Joi.string().min(2).max(100).optional(),
    phone:         Joi.string().optional().allow(''),
    website:       Joi.string().optional().allow(''),
    logo_url:      Joi.string().optional().allow(''),
    upi_id:        Joi.string().optional().allow(''),
    brand_color:   Joi.string().optional().allow(''),
    webhook_url:   Joi.string().optional().allow(''),
  }),
  parseSms: Joi.object({
    sms:        Joi.string().min(10).max(2000).required(),
    sender:     Joi.string().max(20).optional().allow(''),
    payment_id: Joi.string().optional().allow(''),
  }),
};

// ─── error.middleware.js ──────────────────────────────────────────────────────
const notFoundHandler = (req, res) => res.status(404).json({
  success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` },
});

const errorHandler = (err, req, res, next) => {
  const isDev = process.env.NODE_ENV !== 'production';
  logger.error(`${err.message} — ${req.method} ${req.originalUrl}`);
  res.status(err.statusCode || err.status || 500).json({
    success: false,
    error: { code: err.code || 'INTERNAL_ERROR', message: isDev ? err.message : 'An unexpected error occurred' },
    ...(isDev && { stack: err.stack }),
  });
};

module.exports = {
  securityMiddleware,
  globalRateLimiter, authRateLimiter, paymentRateLimiter, smsRateLimiter,
  validate, schemas,
  notFoundHandler, errorHandler,
};
