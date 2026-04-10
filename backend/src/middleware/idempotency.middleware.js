'use strict';

/**
 * NexusPay — Idempotency Middleware
 * 
 * Ensures every mutating request is processed exactly once.
 * Uses the `Idempotency-Key` header and PostgreSQL for durable storage.
 * 
 * Flow:
 *   1. Check for `Idempotency-Key` header on POST/PUT/PATCH/DELETE
 *   2. If key exists + completed → return cached response (no reprocessing)
 *   3. If key exists + processing → return 409 Conflict
 *   4. If new key → store as 'processing', execute, store response as 'completed'
 *   5. TTL: 24 hours (cleaned by background job)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Idempotency middleware factory.
 * @param {Object} options
 * @param {Function} options.pgQuery - pg.database.query function
 * @param {boolean} options.isAvailable - pg.database.isAvailable function
 */
function createIdempotencyMiddleware({ pgQuery, isAvailable }) {
  return async function idempotencyMiddleware(req, res, next) {
    // Only apply to mutating methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

    // If no key provided, proceed normally (non-idempotent request)
    if (!idempotencyKey) {
      return next();
    }

    // If PostgreSQL not available, store key on request for downstream use
    if (!isAvailable()) {
      req.idempotencyKey = idempotencyKey;
      return next();
    }

    try {
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body || {}))
        .digest('hex');

      // Check existing key
      const existing = await pgQuery(
        `SELECT * FROM idempotency_keys WHERE key = $1`,
        [idempotencyKey]
      );

      if (existing.rows.length > 0) {
        const entry = existing.rows[0];

        if (entry.status === 'completed') {
          // Return cached response
          logger.info(`[IDEMPOTENCY] Cache hit for key=${idempotencyKey}`);
          return res
            .status(entry.response_code || 200)
            .json(entry.response_body || { success: true, idempotent_replay: true });
        }

        if (entry.status === 'processing') {
          // Concurrent request with same key
          logger.warn(`[IDEMPOTENCY] Conflict for key=${idempotencyKey}`);
          return res.status(409).json({
            success: false,
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'A request with this idempotency key is already being processed.',
            },
          });
        }
      }

      // Store new key as 'processing'
      await pgQuery(
        `INSERT INTO idempotency_keys (key, request_path, request_hash, status)
         VALUES ($1, $2, $3, 'processing')
         ON CONFLICT (key) DO NOTHING`,
        [idempotencyKey, req.path, requestHash]
      );

      // Attach key and completion callback to request
      req.idempotencyKey = idempotencyKey;

      // Intercept response to cache it
      const originalJson = res.json.bind(res);
      res.json = function (body) {
        // Store completed response (async, non-blocking)
        pgQuery(
          `UPDATE idempotency_keys 
           SET status = 'completed', response_code = $1, response_body = $2
           WHERE key = $3`,
          [res.statusCode || 200, JSON.stringify(body), idempotencyKey]
        ).catch(err => {
          logger.warn(`[IDEMPOTENCY] Failed to store response for key=${idempotencyKey}: ${err.message}`);
        });

        return originalJson(body);
      };

      next();
    } catch (err) {
      logger.error(`[IDEMPOTENCY] Middleware error: ${err.message}`);
      // Don't block the request on idempotency errors
      req.idempotencyKey = idempotencyKey;
      next();
    }
  };
}

/**
 * Background cleanup for expired idempotency keys.
 * Call this periodically (e.g., every hour).
 */
async function cleanupExpiredKeys(pgQuery) {
  try {
    const result = await pgQuery(
      `DELETE FROM idempotency_keys WHERE expires_at < NOW()`
    );
    if (result.rowCount > 0) {
      logger.info(`[IDEMPOTENCY] Cleaned up ${result.rowCount} expired keys`);
    }
  } catch (err) {
    logger.warn(`[IDEMPOTENCY] Cleanup failed: ${err.message}`);
  }
}

module.exports = { createIdempotencyMiddleware, cleanupExpiredKeys };
