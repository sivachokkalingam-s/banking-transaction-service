'use strict';

const axios = require('axios');
const logger = require('./logger');

const TIMEOUT_MS      = parseInt(process.env.REQUEST_TIMEOUT_MS  || '5000', 10);
const MAX_RETRIES     = parseInt(process.env.MAX_RETRY_ATTEMPTS  || '3', 10);
const BASE_DELAY_MS   = 200;

/**
 * Sleep helper
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Determine whether an error is transient and worth retrying.
 */
function isRetryable(err) {
  if (!err.response) return true; // network / timeout
  const status = err.response.status;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Generic HTTP call with exponential backoff.
 *
 * @param {object} opts - axios request config
 * @param {string} correlationId
 * @param {string} label - log label e.g. "account-service:getAccount"
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function httpCall(opts, correlationId, label = 'http') {
  const config = {
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-ID': correlationId || 'unknown',
      'X-Source-Service': process.env.SERVICE_NAME || 'transaction-service',
      ...(opts.headers || {}),
    },
    ...opts,
  };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const start = Date.now();
      const res = await axios(config);
      logger.info({
        event: 'http_success',
        label,
        attempt,
        status: res.status,
        latencyMs: Date.now() - start,
        correlationId,
      });
      return res;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      logger.warn({
        event: 'http_error',
        label,
        attempt,
        status,
        message: err.message,
        correlationId,
      });

      if (!isRetryable(err) || attempt === MAX_RETRIES) break;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 200, 400, 800
      logger.info({ event: 'http_retry', label, delayMs: delay, correlationId });
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { httpCall };
