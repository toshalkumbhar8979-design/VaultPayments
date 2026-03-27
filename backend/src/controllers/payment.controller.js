'use strict';

const { v4: uuidv4 } = require('uuid');
const { payments, merchants, transactions } = require('../config/database');
const switchService    = require('../services/switch.service');
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
      // Card-specific (for card connector)
      card_token, card_last4, card_brand, _testCardNumber,
    } = req.body;

    const currencyConfig = CURRENCIES[currency];
    if (!currencyConfig) return sendError(res, 400, `Unsupported currency: ${currency}`, 'INVALID_CURRENCY');

    const minAmount = 100;
    const maxAmount = 50000000;
    if (amount < minAmount) return sendError(res, 400, `Minimum amount is ${currencyConfig.symbol}1`, 'INVALID_AMOUNT');
    if (amount > maxAmount) return sendError(res, 400, `Maximum amount exceeded`, 'INVALID_AMOUNT');

    // Duplicate order check
    if (await payments.findByOrderId(order_id, merchantId)) {
      return sendError(res, 409, `Payment for order_id '${order_id}' already exists`, 'DUPLICATE_ORDER');
    }

    const paymentId  = `pay_${uuidv4().replace(/-/g,'').substring(0,20)}`;
    const gatewayFee = Math.ceil(amount * (parseFloat(process.env.GATEWAY_FEE_PERCENT) || GATEWAY_FEE_PERCENT) / 100);
    const netAmount  = amount - gatewayFee;
    const now        = new Date().toISOString();
    const expiresAt  = new Date(Date.now() + expires_in * 1000).toISOString();
    const amountFmt  = `${currencyConfig.symbol}${(amount / currencyConfig.multiplier).toFixed(2)}`;

    // ── Route through the Payment Switch ────────────────────────────────
    const switchResult = await switchService.processPayment({
      paymentId,
      merchantId,
      merchant,
      amount,
      currency,
      paymentMethod: payment_method,
      customer,
      description,
      metadata,
      callbackUrl: callback_url,
      redirectUrl: redirect_url,
      expiresIn: expires_in,
      cardToken:  card_token,
      cardLast4:  card_last4,
      cardBrand:  card_brand,
      _testCardNumber,
    });

    if (!switchResult.success && switchResult.status === 'declined') {
      // Record the declined payment
      await payments.create({
        id: paymentId, merchant_id: merchantId, order_id, amount, currency,
        status: 'declined', customer_name: customer.name, customer_email: customer.email,
        customer_phone: customer.phone, description, qr_code: '', payment_method,
        connector_name: switchResult.connectorName || '', connector_ref: '',
        card_token: card_token || '', card_brand: card_brand || '', card_last4: card_last4 || '',
        gateway_fee: gatewayFee, net_amount: netAmount, metadata: JSON.stringify(metadata),
        callback_url: callback_url || '', redirect_url: redirect_url || '',
        decline_code: switchResult.declineCode || '', retry_count: switchResult.retryCount || 0,
        created_at: now, updated_at: now, expires_at: expiresAt,
      });
      return sendError(res, 402, switchResult.rawResponse?.message || 'Payment declined', 'PAYMENT_DECLINED');
    }

    if (!switchResult.success) {
      return sendError(res, 502, switchResult.error?.message || 'Payment processing failed', switchResult.error?.code || 'SWITCH_ERROR');
    }

    // Map switch status to payment status
    let paymentStatus = PAYMENT_STATUS.CREATED;
    if (switchResult.status === 'authorized') paymentStatus = 'authorized';
    if (switchResult.status === 'requires_action') paymentStatus = PAYMENT_STATUS.PROCESSING;
    if (switchResult.status === 'requires_3ds') paymentStatus = PAYMENT_STATUS.PROCESSING;

    const payment = await payments.create({
      id:             paymentId,
      merchant_id:    merchantId,
      order_id,
      amount,
      currency,
      status:         paymentStatus,
      customer_name:  customer.name,
      customer_email: customer.email,
      customer_phone: customer.phone,
      description,
      qr_code:        switchResult.qrCode || '',
      payment_method,
      connector_name: switchResult.connectorName || '',
      connector_ref:  switchResult.connectorRef || '',
      card_token:     card_token || '',
      card_brand:     switchResult.rawResponse?.cardBrand || card_brand || '',
      card_last4:     switchResult.rawResponse?.cardLast4 || card_last4 || '',
      gateway_fee:    gatewayFee,
      net_amount:     netAmount,
      metadata:       JSON.stringify(metadata),
      callback_url:   callback_url || '',
      redirect_url:   redirect_url || '',
      decline_code:   '',
      retry_count:    switchResult.retryCount || 0,
      created_at:     now,
      updated_at:     now,
      expires_at:     expiresAt,
    });

    // Fixed: Using relative URL if FRONTEND_URL is missing or local, 
    // to prevent iframe loading issues on live servers.
    const gatewayUrl = process.env.FRONTEND_URL && !process.env.FRONTEND_URL.includes('localhost') 
      ? `${process.env.FRONTEND_URL}/pay/?id=${paymentId}`
      : `../pay/?id=${paymentId}`;

    logger.info(`Payment created: ${paymentId} | ${amountFmt} | connector: ${switchResult.connectorName} | merchant: ${merchantId}`);

    return sendSuccess(res, 201, 'Payment created', {
      payment_id:       payment.id,
      order_id:         payment.order_id,
      amount:           payment.amount,
      amount_formatted: amountFmt,
      currency,
      status:           payment.status,
      connector:        switchResult.connectorName,
      qr_code:          switchResult.qrCode || null,
      virtual_account:  switchResult.virtualAccount || null,
      three_ds_url:     switchResult.threeDSUrl || null,
      gateway_url:      gatewayUrl,
      expires_at:       expiresAt,
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
const getCheckoutData = async (req, res) => {
  try {
    const payment = await payments.findById(req.params.payment_id);
    if (!payment) return sendError(res, 404, 'Payment not found', 'PAYMENT_NOT_FOUND');

    if (new Date(payment.expires_at) < new Date()) {
      await payments.update(payment.id, { status: PAYMENT_STATUS.EXPIRED });
      return sendError(res, 410, 'Payment link has expired', 'PAYMENT_EXPIRED');
    }
    if (payment.status === PAYMENT_STATUS.CAPTURED) {
      return sendError(res, 409, 'Payment already completed', 'PAYMENT_ALREADY_CAPTURED');
    }

    const merchant = await merchants.findById(payment.merchant_id);
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
const getPayment = async (req, res) => {
  const payment = await payments.findById(req.params.payment_id);
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
const listPayments = async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const list  = await payments.listByMerchant(req.merchantId, limit);
  return sendSuccess(res, 200, 'Payments', { payments: list, count: list.length });
};

// POST /payments/:id/capture
const capturePayment = async (req, res) => {
  try {
    const payment = await payments.findById(req.params.payment_id);
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
    const updated = await payments.update(payment.id, { status: PAYMENT_STATUS.CAPTURED, captured_at: capturedAt });

    // Record transaction
    await transactions.create({
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
      platformName: process.env.PLATFORM_NAME || 'NexusPay',
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
  const payment = await payments.findById(req.params.payment_id);
  if (!payment || payment.merchant_id !== req.merchantId) {
    return sendError(res, 404, 'Payment not found');
  }
  if (payment.status !== PAYMENT_STATUS.CAPTURED) {
    return sendError(res, 400, 'Only captured payments can be refunded');
  }
  const refundedAt = new Date().toISOString();
  await payments.update(payment.id, { status: PAYMENT_STATUS.REFUNDED, refunded_at: refundedAt });
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
      'X-NexusPay-Signature': sig,
      'X-NexusPay-Event': event,
      'User-Agent': `${process.env.PLATFORM_NAME || 'NexusPay'}-Webhook/1.0`,
    },
    body: payload,
    signal: AbortSignal.timeout(10000),
  });
}

module.exports = { createPayment, getCheckoutData, getPayment, listPayments, capturePayment, refundPayment };
