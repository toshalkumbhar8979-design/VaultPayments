'use strict';
const { v4: uuidv4 } = require('uuid');
const { payments, smsLogs } = require('../config/database');
const { SMS_PATTERNS, PAYMENT_STATUS } = require('../config/constants');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');

const parseSmsText = (sms) => {
  const result = { type: null, amount: null, transactionId: null, bank: null, account: null };
  const lower  = sms.toLowerCase();

  // Detect credit/debit
  if (/credited|credit|received|cr\./.test(lower)) result.type = 'credit';
  else if (/debited|debit|paid|sent|dr\./.test(lower)) result.type = 'debit';

  // Extract amount from credit patterns
  for (const pat of SMS_PATTERNS.CREDIT) {
    const m = sms.match(pat);
    if (m) { result.amount = parseFloat(m[1].replace(/,/g, '')); result.type = result.type || 'credit'; break; }
  }
  // Try debit patterns if no amount yet
  if (!result.amount) {
    for (const pat of SMS_PATTERNS.DEBIT) {
      const m = sms.match(pat);
      if (m) { result.amount = parseFloat(m[1].replace(/,/g, '')); result.type = result.type || 'debit'; break; }
    }
  }

  // Transaction ID
  for (const pat of SMS_PATTERNS.TXN_ID) {
    const m = sms.match(pat);
    if (m) { result.transactionId = m[1]; break; }
  }

  // Bank detection
  for (const [name, pattern] of Object.entries(SMS_PATTERNS.BANKS)) {
    if (new RegExp(pattern, 'i').test(sms)) { result.bank = name; break; }
  }

  // Account number (last 4 digits)
  const acct = sms.match(/a\/c\s*(?:no\.?)?\s*[Xx*]+(\d{4})/i) || sms.match(/account\s*[Xx*]+(\d{4})/i);
  if (acct) result.account = `XXXX${acct[1]}`;

  return result;
};

// POST /sms/parse
const parseSms = async (req, res) => {
  try {
    const { sms, sender, payment_id } = req.body;
    const parsed = parseSmsText(sms);

    if (!parsed.amount) {
      return sendSuccess(res, 200, 'SMS parsed — no payment amount detected', {
        parsed: { type: parsed.type, amount: null, transaction_id: null, bank: null },
        matched_payment: null,
        action_taken: null,
      });
    }

    let matchedPayment = null;
    let actionTaken    = null;

    if (payment_id) {
      // Direct match
      const payment = payments.findById(payment_id);
      if (payment && payment.merchant_id === req.merchantId) {
        const rupeeAmt = payment.amount / 100;
        if (Math.abs(rupeeAmt - parsed.amount) <= 0.01) {
          if ([PAYMENT_STATUS.CREATED, PAYMENT_STATUS.PROCESSING].includes(payment.status)) {
            payments.update(payment_id, {
              status:       PAYMENT_STATUS.CAPTURED,
              captured_at:  new Date().toISOString(),
              sms_ack_txn_id: parsed.transactionId || '',
            });
            matchedPayment = payment;
            actionTaken    = 'captured';
          } else {
            matchedPayment = payment;
            actionTaken    = 'already_processed';
          }
        } else {
          matchedPayment = payment;
          actionTaken    = 'amount_mismatch';
        }
      }
    } else {
      // Auto-match by scanning merchant's pending payments
      const pending = payments.listByMerchant(req.merchantId, 100)
        .filter(p => [PAYMENT_STATUS.CREATED, PAYMENT_STATUS.PROCESSING].includes(p.status));

      for (const p of pending) {
        if (Math.abs(p.amount / 100 - parsed.amount) <= 0.01 && parsed.transactionId) {
          payments.update(p.id, {
            status:          PAYMENT_STATUS.CAPTURED,
            captured_at:     new Date().toISOString(),
            sms_ack_txn_id:  parsed.transactionId,
          });
          matchedPayment = p;
          actionTaken    = 'auto_captured';
          logger.info(`SMS auto-capture: ${p.id} txn=${parsed.transactionId}`);
          break;
        }
      }
    }

    // Log SMS
    smsLogs.create({
      id:                 uuidv4(),
      merchant_id:        req.merchantId,
      sender:             sender || '',
      sms_text:           sms,
      parsed_amount:      parsed.amount,
      parsed_txn_id:      parsed.transactionId || '',
      parsed_bank:        parsed.bank || '',
      matched_payment_id: matchedPayment?.id || '',
      action_taken:       actionTaken || '',
      created_at:         new Date().toISOString(),
    });

    return sendSuccess(res, 200, 'SMS parsed', {
      parsed: {
        type:           parsed.type,
        amount:         parsed.amount,
        transaction_id: parsed.transactionId,
        bank:           parsed.bank,
        account:        parsed.account,
      },
      matched_payment: matchedPayment ? { id: matchedPayment.id, order_id: matchedPayment.order_id, amount: matchedPayment.amount } : null,
      action_taken:    actionTaken,
    });
  } catch (err) {
    logger.error('SMS parse error:', err);
    return sendError(res, 500, 'SMS parsing failed');
  }
};

// POST /sms/webhook (Twilio)
const smsWebhook = (req, res) => {
  const { Body } = req.body || {};
  if (Body) {
    const parsed = parseSmsText(Body);
    logger.info(`SMS webhook received: amount=${parsed.amount} txn=${parsed.transactionId} bank=${parsed.bank}`);
  }
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
};

module.exports = { parseSms, smsWebhook, parseSmsText };
