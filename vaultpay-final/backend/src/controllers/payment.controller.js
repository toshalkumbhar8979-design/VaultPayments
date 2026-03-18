'use strict';

const { v4: uuidv4 } = require('uuid');
const { payments, merchants, transactions } = require('../config/database');
const { generatePaymentQR }    = require('../services/qr.service');
const { sendPaymentConfirmation } = require('../services/email.service');
const { signPayload }          = require('../services/crypto.service');
const { sendSuccess, sendError } = require('../utils/response');
const { CURRENCIES, PAYMENT_STATUS, GATEWAY_FEE_PERCENT } = require('../config/constants');
const logger = require('../utils/logger');

// POST /payments/create
const createPayment = async (req, res) => {
  try {
    const { merchantId, merchant } = req;
    const {
      order_id, amount, currency = 'INR', customer,
      description = '', payment_method = 'qr',
      metadata = {}, callback_url, redirect_url,
      expires_in = 3600,
    } = req.body;

    const currencyConfig = CURRENCIES[currency];
    if (!currencyConfig) return sendError(res, 400, `Unsupported currency: ${currency}`, 'INVALID_CURRENCY');

    const minAmount = 100; // 1 unit in smallest currency
    const maxAmount = 50000000;
    if (amount < minAmount) return sendError(res, 400, `Minimum amount is ${currencyConfig.symbol}1`, 'INVALID_AMOUNT');
    if (amount > maxAmount) return sendError(res, 400, `Maximum amount exceeded`, 'INVALID_AMOUNT');

    // Duplicate order check
    if (payments.findByOrderId(order_id, merchantId)) {
      return sendError(res, 409, `Payment for order_id '${order_id}' already exists`, 'DUPLICATE_ORDER');
    }

    const paymentId  = `pay_${uuidv4().replace(/-/g,'').substring(0,20)}`;
    const gatewayFee = Math.ceil(amount * (parseFloat(process.env.GATEWAY_FEE_PERCENT) || GATEWAY_FEE_PERCENT) / 100);
    const netAmount  = amount - gatewayFee;
    const now        = new Date().toISOString();
    const expiresAt  = new Date(Date.now() + expires_in * 1000).toISOString();
    const amountFmt  = `${currencyConfig.symbol}${(amount / currencyConfig.multiplier).toFixed(2)}`;

    // Generate QR
    const qrCode = await generatePaymentQR({
      paymentId, amount: (amount / currencyConfig.multiplier).toFixed(2),
      currency, merchantName: merchant.business_name || merchant.name,
      description,
    });

    const payment = payments.create({
      id:             paymentId,
      merchant_id:    merchantId,
      order_id,
      amount,
      currency,
      status:         PAYMENT_STATUS.CREATED,
      customer_name:  customer.name,
      customer_email: customer.email,
      customer_phone: customer.phone,
      description,
      qr_code:        qrCode,
      payment_method,
      gateway_fee:    gatewayFee,
      net_amount:     netAmount,
      metadata:       JSON.stringify(metadata),
      callback_url:   callback_url || '',
      redirect_url:   redirect_url || '',
      created_at:     now,
      updated_at:     now,
      expires_at:     expiresAt,
    });

    const gatewayUrl = `${process.env.FRONTEND_URL || ''}/pay/?id=${paymentId}`;

    logger.info(`Payment created: ${paymentId} | ${amountFmt} | merchant: ${merchantId}`);

    return sendSuccess(res, 201, 'Payment created', {
      payment_id:      payment.id,
      order_id:        payment.order_id,
      amount:          payment.amount,
      amount_formatted:amountFmt,
      currency,
      status:          payment.status,
      qr_code:         qrCode,
      gateway_url:     gatewayUrl,
      expires_at:      expiresAt,
      merchant: {
        name:        merchant.business_name || merchant.name,
        brand_color: merchant.brand_color,
        logo_url:    merchant.logo_url,
      },
    });
  } catch (err) {
    logger.error('Create payment error:', err);
    return sendError(res, 500, 'Failed to create payment');
  }
};

// GET /payments/checkout/:id (public — no auth)
const getCheckoutData = (req, res) => {
  try {
    const payment = payments.findById(req.params.payment_id);
    if (!payment) return sendError(res, 404, 'Payment not found', 'PAYMENT_NOT_FOUND');

    if (new Date(payment.expires_at) < new Date()) {
      payments.update(payment.id, { status: PAYMENT_STATUS.EXPIRED });
      return sendError(res, 410, 'Payment link has expired', 'PAYMENT_EXPIRED');
    }
    if (payment.status === PAYMENT_STATUS.CAPTURED) {
      return sendError(res, 409, 'Payment already completed', 'PAYMENT_ALREADY_CAPTURED');
    }

    const merchant = merchants.findById(payment.merchant_id);
    const currency = CURRENCIES[payment.currency] || CURRENCIES.INR;

    return sendSuccess(res, 200, 'Checkout data', {
      payment_id:       payment.id,
      amount:           payment.amount,
      amount_formatted: `${currency.symbol}${(payment.amount/currency.multiplier).toFixed(2)}`,
      currency:         payment.currency,
      currency_symbol:  currency.symbol,
      description:      payment.description,
      status:           payment.status,
      qr_code:          payment.qr_code,
      expires_at:       payment.expires_at,
      created_at:       payment.created_at,
      redirect_url:     payment.redirect_url,
      merchant: {
        name:        merchant?.business_name || merchant?.name || 'Merchant',
        brand_color: merchant?.brand_color || '#5b4fff',
        logo_url:    merchant?.logo_url || '',
      },
      customer: {
        name:  payment.customer_name,
        email: payment.customer_email,
      },
    });
  } catch (err) {
    logger.error('Get checkout error:', err);
    return sendError(res, 500, 'Failed to load checkout');
  }
};

// GET /payments/:id
const getPayment = (req, res) => {
  const payment = payments.findById(req.params.payment_id);
  if (!payment || payment.merchant_id !== req.merchantId) {
    return sendError(res, 404, 'Payment not found', 'PAYMENT_NOT_FOUND');
  }
  const currency = CURRENCIES[payment.currency] || CURRENCIES.INR;
  return sendSuccess(res, 200, 'Payment', {
    ...payment,
    amount_formatted: `${currency.symbol}${(payment.amount/currency.multiplier).toFixed(2)}`,
  });
};

// GET /payments
const listPayments = (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const list  = payments.listByMerchant(req.merchantId, limit);
  return sendSuccess(res, 200, 'Payments', { payments: list, count: list.length });
};

// POST /payments/:id/capture
const capturePayment = async (req, res) => {
  try {
    const payment = payments.findById(req.params.payment_id);
    if (!payment || payment.merchant_id !== req.merchantId) {
      return sendError(res, 404, 'Payment not found');
    }
    if (payment.status === PAYMENT_STATUS.CAPTURED) {
      return sendError(res, 409, 'Payment already captured', 'PAYMENT_ALREADY_CAPTURED');
    }
    if (payment.status === PAYMENT_STATUS.FAILED) {
      return sendError(res, 400, 'Cannot capture a failed payment');
    }
    if (new Date(payment.expires_at) < new Date()) {
      return sendError(res, 410, 'Payment expired', 'PAYMENT_EXPIRED');
    }

    const capturedAt = new Date().toISOString();
    const updated = payments.update(payment.id, { status: PAYMENT_STATUS.CAPTURED, captured_at: capturedAt });

    // Record transaction
    transactions.create({
      id:          `txn_${uuidv4().replace(/-/g,'').substring(0,20)}`,
      payment_id:  payment.id,
      merchant_id: req.merchantId,
      type:        'credit',
      amount:      payment.amount,
      fee:         payment.gateway_fee,
      net_amount:  payment.net_amount,
      gateway_ref: `VPG${Date.now()}`,
      status:      'settled',
      created_at:  capturedAt,
    });

    // Send email receipt (non-blocking)
    sendPaymentConfirmation({
      to:           payment.customer_email,
      customerName: payment.customer_name,
      merchantName: req.merchant.business_name || req.merchant.name,
      paymentId:    payment.id,
      orderId:      payment.order_id,
      amount:       payment.amount,
      currency:     payment.currency,
      description:  payment.description,
      capturedAt,
      brandColor:   req.merchant.brand_color,
      platformName: process.env.PLATFORM_NAME || 'VaultPay',
    }).catch(err => logger.warn('Email failed:', err.message));

    // Fire webhook
    if (req.merchant.webhook_url) {
      fireWebhook(req.merchant, 'payment.captured', updated).catch(logger.error);
    }

    logger.info(`Payment captured: ${payment.id}`);
    const currency = CURRENCIES[payment.currency] || CURRENCIES.INR;

    return sendSuccess(res, 200, 'Payment captured', {
      payment_id:       payment.id,
      status:           PAYMENT_STATUS.CAPTURED,
      amount_formatted: `${currency.symbol}${(payment.amount/currency.multiplier).toFixed(2)}`,
      captured_at:      capturedAt,
    });
  } catch (err) {
    logger.error('Capture error:', err);
    return sendError(res, 500, 'Capture failed');
  }
};

// POST /payments/:id/refund
const refundPayment = async (req, res) => {
  const payment = payments.findById(req.params.payment_id);
  if (!payment || payment.merchant_id !== req.merchantId) {
    return sendError(res, 404, 'Payment not found');
  }
  if (payment.status !== PAYMENT_STATUS.CAPTURED) {
    return sendError(res, 400, 'Only captured payments can be refunded');
  }
  const refundedAt = new Date().toISOString();
  payments.update(payment.id, { status: PAYMENT_STATUS.REFUNDED, refunded_at: refundedAt });
  logger.info(`Refund: ${payment.id}`);
  return sendSuccess(res, 200, 'Refund initiated', { payment_id: payment.id, status: 'refunded', refunded_at: refundedAt });
};

async function fireWebhook(merchant, event, data) {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  const sig = signPayload(payload, merchant.webhook_secret);
  await fetch(merchant.webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VaultPay-Signature': sig,
      'X-VaultPay-Event': event,
      'User-Agent': `${process.env.PLATFORM_NAME || 'VaultPay'}-Webhook/1.0`,
    },
    body: payload,
    signal: AbortSignal.timeout(10000),
  });
}

module.exports = { createPayment, getCheckoutData, getPayment, listPayments, capturePayment, refundPayment };
