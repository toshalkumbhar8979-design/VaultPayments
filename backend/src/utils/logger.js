'use strict';
const { createLogger, format, transports } = require('winston');
const isProd = process.env.NODE_ENV === 'production';
const logger = createLogger({
  level: isProd ? 'warn' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    isProd
      ? format.json()
      : format.combine(
          format.colorize(),
          format.printf(({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`)
        )
  ),
  transports: [new transports.Console()],
  exceptionHandlers:  [new transports.Console()],
  rejectionHandlers:  [new transports.Console()],
});
logger.http = (msg) => logger.log('http', msg);
module.exports = logger;
