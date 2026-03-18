'use strict';
const sendSuccess = (res, code = 200, message = 'OK', data = {}) =>
  res.status(code).json({ success: true, message, data, timestamp: new Date().toISOString() });

const sendError = (res, code = 500, message = 'Error', errorCode = null, details = null) =>
  res.status(code).json({
    success: false,
    error: { code: errorCode || 'ERROR', message, ...(details && { details }) },
    timestamp: new Date().toISOString(),
  });

module.exports = { sendSuccess, sendError };
