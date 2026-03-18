'use strict';
const crypto = require('crypto');
const ALGO   = 'aes-256-gcm';

const getKey = () => {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length < 32) throw new Error('ENCRYPTION_KEY must be 32+ hex chars');
  return Buffer.from(k.padEnd(32, '0').substring(0, 32));
};

const encrypt = (text) => {
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv(ALGO, getKey(), iv, { authTagLength: 16 });
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
};

const decrypt = (data) => {
  const [ivH, tagH, encH] = data.split(':');
  const d = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivH, 'hex'), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encH, 'hex')), d.final()]).toString('utf8');
};

const signPayload = (payload, secret) => {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `sha256=${crypto.createHmac('sha256', secret).update(data).digest('hex')}`;
};

const verifySignature = (payload, signature, secret) => {
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(signPayload(payload, secret)));
  } catch { return false; }
};

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

module.exports = { encrypt, decrypt, signPayload, verifySignature, randomToken };
