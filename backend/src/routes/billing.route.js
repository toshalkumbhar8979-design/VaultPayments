'use strict';

/**
 * NexusPay — Billing API Routes
 */

const express = require('express');
const billingService = require('../services/billing.service');
const { authenticateJWT } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

const router = express.Router();

// Apply merchant auth middleware to all billing routes
router.use(authenticateJWT);

router.post('/plans', async (req, res, next) => {
  try {
    const { name, amount, currency, interval } = req.body;
    const plan = await billingService.createPlan(req.merchant.id, { name, amount, currency, interval });
    res.json({ success: true, data: plan });
  } catch (err) {
    logger.error('[API] Failed to create plan:', err);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

router.get('/plans', async (req, res, next) => {
  try {
    const plans = await billingService.listPlans(req.merchant.id);
    res.json({ success: true, data: plans });
  } catch (err) {
    next(err);
  }
});

router.post('/subscriptions', async (req, res, next) => {
  try {
    const { planId, customerEmail } = req.body;
    const sub = await billingService.createSubscription(req.merchant.id, planId, customerEmail);
    res.json({ success: true, data: sub });
  } catch (err) {
    logger.error('[API] Failed to parse subscription:', err);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

router.get('/subscriptions', async (req, res, next) => {
  try {
    const subs = await billingService.listSubscriptions(req.merchant.id);
    res.json({ success: true, data: subs });
  } catch (err) {
    next(err);
  }
});

router.delete('/subscriptions/:id', async (req, res, next) => {
  try {
    const result = await billingService.cancelSubscription(req.merchant.id, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

module.exports = router;
