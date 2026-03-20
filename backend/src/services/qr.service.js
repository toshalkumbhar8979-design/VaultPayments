'use strict';
const QRCode = require('qrcode');
const logger  = require('../utils/logger');

const generatePaymentQR = async ({ paymentId, amount, currency, merchantName, description }) => {
  try {
    const upiVpa = process.env.UPI_VPA || 'nexuspay@upi';
    const upiString = `upi://pay?pa=${upiVpa}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=${currency}&tn=${encodeURIComponent((description || paymentId).substring(0, 50))}&mc=5411`;
    return await QRCode.toDataURL(upiString, {
      errorCorrectionLevel: 'H', type: 'image/png', quality: 0.95, margin: 2, width: 400,
      color: { dark: '#0f0f0f', light: '#ffffff' },
    });
  } catch (err) {
    logger.error('QR generation error:', err.message);
    return generateFallback(paymentId);
  }
};

const generateTextQR = async (text, opts = {}) => {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M', type: 'image/png', quality: 0.9,
    margin: 1, width: Math.min(opts.width || 256, 512),
    color: { dark: opts.darkColor || '#000000', light: opts.lightColor || '#ffffff' },
  });
};

const generateFallback = (id) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><text x="100" y="100" text-anchor="middle" font-size="11" fill="#666">QR: ${id.substring(0,16)}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

module.exports = { generatePaymentQR, generateTextQR };
