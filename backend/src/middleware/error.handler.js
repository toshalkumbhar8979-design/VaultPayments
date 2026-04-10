'use strict';

const logger = require('../utils/logger');
const { sendError } = require('../utils/response');

/**
 * NexusPay — Global Error Handler Middleware
 * 
 * Intercepts all unhandled exceptions and returns a consistent 
 * JSON response following the Hyperswitch-standardized error schema.
 */

function errorHandler(err, req, res, next) {
  logger.error(`[ERROR_HANDLER] ${err.name}: ${err.message}`, {
    stack:   err.stack,
    path:    req.path,
    method:  req.method,
    body:    req.body,
    merchant: req.merchantId || 'anonymous'
  });

  // 1. Identify specific error types and map them to standard codes
  let status = err.status || 500;
  let code = err.code || 'INTERNAL_SERVER_ERROR';
  let message = err.message || 'Something went wrong on our end';
  let details = err.details || null;

  // Type-specific overrides
  if (err.name === 'ValidationError' || err.isJoi) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Input validation failed';
    details = err.details || err.message;
  } else if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    status = 401;
    code = 'UNAUTHORIZED';
    message = 'Invalid or expired authentication credentials';
  } else if (err.name === 'ForbiddenError') {
    status = 403;
    code = 'FORBIDDEN';
    message = 'Access to this resource is denied';
  } else if (err.name === 'NotFoundError') {
    status = 404;
    code = 'NOT_FOUND';
  }

  // 2. Clear out sensitive info from general messages
  if (process.env.NODE_ENV === 'production' && status === 500) {
    message = 'Internal Server Error';
  }

  return sendError(res, status, message, code, details);
}

module.exports = errorHandler;
