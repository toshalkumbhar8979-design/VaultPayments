'use strict';
const PAYMENT_STATUS = { CREATED:'created', PROCESSING:'processing', CAPTURED:'captured', FAILED:'failed', REFUNDED:'refunded', EXPIRED:'expired', CANCELLED:'cancelled' };
const CURRENCIES = {
  INR: { symbol:'₹', multiplier:100, name:'Indian Rupee' },
  USD: { symbol:'$', multiplier:100, name:'US Dollar' },
  EUR: { symbol:'€', multiplier:100, name:'Euro' },
  GBP: { symbol:'£', multiplier:100, name:'British Pound' },
  AED: { symbol:'د.إ', multiplier:100, name:'UAE Dirham' },
};
const GATEWAY_FEE_PERCENT = parseFloat(process.env.GATEWAY_FEE_PERCENT) || 2.5;
const SMS_PATTERNS = {
  CREDIT: [
    /(?:credited|credit|cr\.?)\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:credited|received)/i,
    /paid\s*₹\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:upi|phonepe|gpay|paytm).*?(?:rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  ],
  DEBIT: [
    /(?:debited|debit|dr\.?)\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:debited|paid|sent)/i,
  ],
  TXN_ID: [
    /(?:ref|txn|transaction|utr|rrn|upi\s*ref)\s*(?:no\.?|id|#)?\s*:?\s*([A-Z0-9]{6,22})/i,
  ],
  BANKS: { HDFC:'hdfc', SBI:'state bank|sbi', ICICI:'icici', Axis:'axis', Kotak:'kotak', 'Yes Bank':'yes bank', PNB:'punjab national|pnb', Canara:'canara', PhonePe:'phonepe', GPay:'gpay|google pay', PayTM:'paytm', BHIM:'bhim', BharatPe:'bharatpe' },
};
module.exports = { PAYMENT_STATUS, CURRENCIES, GATEWAY_FEE_PERCENT, SMS_PATTERNS };
