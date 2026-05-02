const winston = require('winston');

const MASK_SENSITIVE = process.env.MASK_SENSITIVE !== 'false';

// Fields to mask in logs
const SENSITIVE_FIELDS = ['email', 'phone', 'password', 'token', 'account_number'];

function maskValue(key, value) {
  if (!MASK_SENSITIVE) return value;
  if (typeof value !== 'string') return value;
  if (SENSITIVE_FIELDS.includes(key.toLowerCase())) {
    if (key.toLowerCase() === 'email') {
      const [local, domain] = value.split('@');
      return `${local.slice(0, 2)}***@${domain}`;
    }
    if (key.toLowerCase() === 'phone') {
      return value.replace(/(\d{2})\d+(\d{2})/, '$1*****$2');
    }
    return '***';
  }
  return value;
}

function maskObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const masked = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'object' && val !== null) {
      masked[key] = maskObject(val);
    } else {
      masked[key] = maskValue(key, val);
    }
  }
  return masked;
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: process.env.SERVICE_NAME || 'transaction-service',
    version: process.env.SERVICE_VERSION || '1.0.0',
  },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: process.env.NODE_ENV !== 'production' }),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length
            ? ' ' + JSON.stringify(maskObject(meta))
            : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

logger.maskObject = maskObject;

module.exports = logger;
