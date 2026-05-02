const axios = require('axios');
const logger = require('./logger');

const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '5000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRY_ATTEMPTS || '3', 10);

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * HTTP call with exponential backoff retry.
 * @param {object} config - axios config
 * @param {number} retries - remaining retries
 * @param {string} correlationId
 */
async function httpCall(config, retries = MAX_RETRIES, correlationId = '') {
  const cfg = {
    timeout: TIMEOUT,
    ...config,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-ID': correlationId,
      'X-Source-Service': process.env.SERVICE_NAME || 'transaction-service',
      ...(config.headers || {}),
    },
  };

  try {
    const res = await axios(cfg);
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const isRetryable = !status || status >= 500 || status === 429;

    if (retries > 0 && isRetryable) {
      const delay = Math.pow(2, MAX_RETRIES - retries) * 200; // 200ms, 400ms, 800ms
      logger.warn('HTTP call failed, retrying', {
        url: config.url,
        status,
        retriesLeft: retries - 1,
        delayMs: delay,
        correlationId,
      });
      await sleep(delay);
      return httpCall(config, retries - 1, correlationId);
    }

    const errMsg = err.response?.data?.error || err.response?.data?.message || err.message;
    logger.error('HTTP call failed permanently', {
      url: config.url,
      status,
      error: errMsg,
      correlationId,
    });

    const error = new Error(errMsg || 'Service call failed');
    error.status = status;
    error.response = err.response?.data;
    throw error;
  }
}

module.exports = { httpCall };
