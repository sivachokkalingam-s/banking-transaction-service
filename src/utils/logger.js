'use strict';

const winston = require('winston');

const MASK_SENSITIVE = process.env.MASK_SENSITIVE !== 'false';

// Mask PII in log objects
function maskSensitive(obj) {
  if (!MASK_SENSITIVE || !obj || typeof obj !== 'object') return obj;
  const masked = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(masked)) {
    if (/email/i.test(key))  masked[key] = maskEmail(masked[key]);
    else if (/phone|mobile/i.test(key)) masked[key] = maskPhone(masked[key]);
    else if (/password|secret|token/i.test(key)) masked[key] = '***';
    else if (masked[key] && typeof masked[key] === 'object') masked[key] = maskSensitive(masked[key]);
  }
  return masked;
}

function maskEmail(v) {
  if (typeof v !== 'string') return v;
  const [local, domain] = v.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

function maskPhone(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/\d(?=\d{4})/g, '*');
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
      const safeMsg = typeof message === 'object' ? maskSensitive(message) : message;
      const safeMeta = maskSensitive(meta);
      return JSON.stringify({
        timestamp,
        level,
        service: process.env.SERVICE_NAME || 'transaction-service',
        version: process.env.SERVICE_VERSION || '1.0.0',
        message: safeMsg,
        ...(stack ? { stack } : {}),
        ...safeMeta,
      });
    })
  ),
  transports: [new winston.transports.Console()],
});

module.exports = logger;
