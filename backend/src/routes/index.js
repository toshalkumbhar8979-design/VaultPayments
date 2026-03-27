'use strict';
/**
 * NexusPay — All API Routes
 */

const express = require('express');
const { authenticateJWT, authenticateApiKey, verifyWebhookSignature } = require('../middleware/auth.middleware');
const { authRateLimiter, paymentRateLimiter, smsRateLimiter, validate, schemas } = require('../middleware');
const { sendSuccess, sendError } = require('../utils/response');
const { generateTextQR } = require('../services/qr.service');
const logger = require('../utils/logger');

const auth     = require('../controllers/auth.controller');
const pay      = require('../controllers/payment.controller');
const merchant = require('../controllers/merchant.controller');
const sms      = require('../controllers/sms.controller');

// ─── Auth ─────────────────────────────────────────────────────────────────────
const authRouter = express.Router();
authRouter.post('/register',        authRateLimiter, validate(schemas.register), auth.register);
authRouter.post('/login',           authRateLimiter, validate(schemas.login),    auth.login);
authRouter.post('/rotate-keys',     authenticateJWT, auth.rotateKeys);
authRouter.post('/forgot-password', authRateLimiter, auth.forgotPassword);

// ─── Payments ─────────────────────────────────────────────────────────────────
const payRouter = express.Router();
payRouter.get('/checkout/:payment_id', pay.getCheckoutData);           // public
payRouter.post('/create',              authenticateApiKey, paymentRateLimiter, validate(schemas.createPayment), pay.createPayment);
payRouter.get('/',                     authenticateApiKey, pay.listPayments);
payRouter.get('/:payment_id',          authenticateApiKey, pay.getPayment);
payRouter.post('/:payment_id/capture', authenticateApiKey, pay.capturePayment);
payRouter.post('/:payment_id/refund',  authenticateApiKey, pay.refundPayment);

// ─── Merchants ────────────────────────────────────────────────────────────────
const merchantRouter = express.Router();
merchantRouter.get('/me',        authenticateJWT, merchant.getProfile);
merchantRouter.put('/me',        authenticateJWT, validate(schemas.updateMerchant), merchant.updateProfile);
merchantRouter.post('/verify-upi', authenticateJWT, merchant.verifyUPI);
merchantRouter.get('/dashboard', authenticateJWT, merchant.getDashboard);

// ─── SMS ──────────────────────────────────────────────────────────────────────
const smsRouter = express.Router();
smsRouter.post('/parse',   authenticateApiKey, smsRateLimiter, validate(schemas.parseSms), sms.parseSms);
smsRouter.post('/webhook', sms.smsWebhook);

// ─── QR ───────────────────────────────────────────────────────────────────────
const qrRouter = express.Router();
qrRouter.post('/generate', authenticateApiKey, async (req, res) => {
  const { text, width, dark_color, light_color } = req.body;
  if (!text) return sendError(res, 400, 'text is required');
  try {
    const qr = await generateTextQR(text, {
      width:      Math.min(parseInt(width) || 256, 512),
      darkColor:  dark_color  || '#000000',
      lightColor: light_color || '#ffffff',
    });
    return sendSuccess(res, 200, 'QR generated', { qr_code: qr });
  } catch { return sendError(res, 500, 'QR generation failed'); }
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────
const webhookRouter = express.Router();
webhookRouter.post('/payment', verifyWebhookSignature, (req, res) => {
  const { event } = req.body;
  logger.info(`Webhook received: ${event}`);
  res.status(200).json({ received: true });
});

module.exports = {
  authRoutes:     authRouter,
  paymentRoutes:  payRouter,
  merchantRoutes: merchantRouter,
  smsRoutes:      smsRouter,
  qrRoutes:       qrRouter,
  webhookRoutes:  webhookRouter,
};
