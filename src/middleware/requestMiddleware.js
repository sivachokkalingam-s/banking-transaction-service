const { v4: uuidv4 } = require('uuid');
const { httpRequestsTotal, httpRequestDurationMs, httpErrorsTotal } = require('../utils/metrics');
const logger = require('../utils/logger');

/**
 * Attach correlationId to every request and log all requests.
 */
function requestContext(req, res, next) {
  req.correlationId =
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    uuidv4();

  res.setHeader('X-Correlation-ID', req.correlationId);
  res.setHeader('X-Service', process.env.SERVICE_NAME || 'transaction-service');

  const start = Date.now();

  res.on('finish', () => {
    const latency = Date.now() - start;
    const route = req.route?.path || req.path;
    const status = String(res.statusCode);

    httpRequestsTotal.inc({ method: req.method, route, status });
    httpRequestDurationMs.observe({ method: req.method, route, status }, latency);

    if (res.statusCode >= 400) {
      httpErrorsTotal.inc({ method: req.method, route, status });
    }

    logger.info('HTTP request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      latencyMs: latency,
      correlationId: req.correlationId,
    });
  });

  next();
}

/**
 * Centralized error handler.
 */
function errorHandler(err, req, res, next) {
  const statusCode = err.status || err.statusCode || 500;
  const message = err.error || err.message || 'Internal server error';
  const code = err.code || 'INTERNAL_ERROR';

  logger.error('Request error', {
    path: req.originalUrl,
    method: req.method,
    status: statusCode,
    error: message,
    code,
    correlationId: req.correlationId,
    stack: statusCode === 500 ? err.stack : undefined,
  });

  return res.status(statusCode).json({
    success: false,
    error: message,
    code,
    correlationId: req.correlationId,
  });
}

/**
 * 404 handler.
 */
function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`,
    code: 'NOT_FOUND',
    correlationId: req.correlationId,
  });
}

module.exports = { requestContext, errorHandler, notFoundHandler };
