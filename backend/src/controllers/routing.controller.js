'use strict';

const { getDb } = require('../config/database');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');

// GET /api/v1/routing/rules
const getRules = async (req, res) => {
  try {
    const { merchantId } = req;
    const rules = await getDb().all(
      'SELECT * FROM routing_rules WHERE merchant_id = ? ORDER BY priority ASC',
      [merchantId]
    );
    return sendSuccess(res, 200, 'Routing rules retrieved', { rules });
  } catch (err) {
    logger.error('Get rules error:', err);
    return sendError(res, 500, 'Failed to fetch routing rules');
  }
};

// POST /api/v1/routing/rules
const updateRule = async (req, res) => {
  try {
    const { merchantId } = req;
    const { id, name, conditions, connector_name, priority, is_active } = req.body;

    if (id) {
      // Update existing
      await getDb().run(
        `UPDATE routing_rules SET 
          name = ?, conditions = ?, connector_name = ?, priority = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND merchant_id = ?`,
        [name, JSON.stringify(conditions), connector_name, priority, is_active ? 1 : 0, id, merchantId]
      );
    } else {
      // Create new
      await getDb().run(
        `INSERT INTO routing_rules (merchant_id, name, conditions, connector_name, priority, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [merchantId, name, JSON.stringify(conditions), connector_name, priority, is_active ? 1 : 0]
      );
    }

    return sendSuccess(res, 200, id ? 'Rule updated' : 'Rule created');
  } catch (err) {
    logger.error('Update rule error:', err);
    return sendError(res, 500, 'Failed to save routing rule');
  }
};

// DELETE /api/v1/routing/rules/:id
const deleteRule = async (req, res) => {
  try {
    const { merchantId } = req;
    await getDb().run(
      'DELETE FROM routing_rules WHERE id = ? AND merchant_id = ?',
      [req.params.id, merchantId]
    );
    return sendSuccess(res, 200, 'Rule deleted');
  } catch (err) {
    logger.error('Delete rule error:', err);
    return sendError(res, 500, 'Failed to delete rule');
  }
};

module.exports = { getRules, updateRule, deleteRule };
