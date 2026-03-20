'use strict';
const nodemailer = require('nodemailer');
const { CURRENCIES } = require('../config/constants');
const logger = require('../utils/logger');

const getTransport = () => {
  if (process.env.NODE_ENV === 'test') return { sendMail: async () => ({ messageId: 'test' }) };
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { rejectUnauthorized: process.env.NODE_ENV === 'production' },
  });
};

const sendPaymentConfirmation = async ({
  to, customerName, merchantName, paymentId, orderId,
  amount, currency, description, capturedAt, brandColor = '#5b4fff', platformName = 'NexusPay',
}) => {
  const cfg = CURRENCIES[currency] || CURRENCIES.INR;
  const amtFmt  = `${cfg.symbol}${(amount / cfg.multiplier).toFixed(2)}`;
  const dateFmt  = new Date(capturedAt).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:sans-serif;">
<table width="100%" style="padding:40px 20px;background:#f4f4f5;"><tr><td align="center">
<table width="560" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  <tr><td style="background:${brandColor};padding:36px 40px;text-align:center;">
    <div style="font-size:28px;">✓</div>
    <h1 style="margin:10px 0 4px;color:#fff;font-size:24px;">Payment Confirmed</h1>
    <p style="margin:0;color:rgba(255,255,255,.8);font-size:14px;">Your payment was successful</p>
  </td></tr>
  <tr><td style="padding:36px 40px 24px;text-align:center;border-bottom:1px solid #f0f0f0;">
    <p style="margin:0 0 4px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Amount Paid</p>
    <h2 style="margin:0;color:#111;font-size:44px;font-weight:900;letter-spacing:-2px;">${amtFmt}</h2>
    <p style="margin:8px 0 0;color:#6b7280;font-size:14px;">to <strong style="color:#374151;">${merchantName}</strong></p>
  </td></tr>
  <tr><td style="padding:24px 40px;">
    ${description ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f9fafb;font-size:13px;"><span style="color:#9ca3af">Description</span><span style="font-weight:600;">${description}</span></div>` : ''}
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f9fafb;font-size:13px;"><span style="color:#9ca3af">Order ID</span><span style="font-weight:600;">${orderId}</span></div>
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f9fafb;font-size:13px;"><span style="color:#9ca3af">Payment ID</span><code style="color:${brandColor};background:#f0f0ff;padding:2px 8px;border-radius:4px;font-size:12px;">${paymentId}</code></div>
    <div style="display:flex;justify-content:space-between;padding:10px 0;font-size:13px;"><span style="color:#9ca3af">Date &amp; Time</span><span>${dateFmt}</span></div>
  </td></tr>
  <tr><td style="padding:0 40px 32px;"><p style="font-size:14px;color:#6b7280;line-height:1.7;">Hi <strong style="color:#374151;">${customerName}</strong>, thank you for your payment. Please keep this receipt for your records.</p></td></tr>
  <tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #f0f0f0;">
    <p style="margin:0;color:#9ca3af;font-size:12px;">Powered by <strong style="color:${brandColor};">${platformName}</strong></p>
    <p style="margin:6px 0 0;color:#d1d5db;font-size:11px;">© ${new Date().getFullYear()} ${platformName}. This is an automated receipt.</p>
  </td></tr>
</table></td></tr></table></body></html>`;

  const info = await getTransport().sendMail({
    from:    `"${process.env.FROM_NAME || platformName}" <${process.env.FROM_EMAIL || 'noreply@nexuspay.io'}>`,
    to,
    subject: `✅ Payment Confirmed — ${amtFmt} to ${merchantName}`,
    html,
    text:    `Payment confirmed! ${amtFmt} paid to ${merchantName}. Order: ${orderId}. Payment ID: ${paymentId}.`,
  });
  logger.info(`Email sent to ${to}: ${info.messageId}`);
  return info;
};

module.exports = { sendPaymentConfirmation };
