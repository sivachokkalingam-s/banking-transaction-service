'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { httpRequestsTotal, httpRequestDurationMs } = require('../utils/metrics');

/**
 * Attach X-Correlation-ID to every request + response.
 * Propagates upstream header if present, else generates a new UUID.
 */
function correlationId(req, res, next) {
  const id = req.headers['x-correlation-id'] || uuidv4();
  req.correlationId = id;
  res.setHeader('X-Correlation-ID', id);
  next();
}

/**
 * Structured JSON request/response logger + Prometheus RED metrics.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  // Normalise route for metric labels (avoid cardinality explosion on IDs)
  const route = req.route?.path || req.path
    .replace(/\/[0-9a-f-]{8,}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');

  res.on('finish', () => {
    const latency = Date.now() - start;
    const status  = String(res.statusCode);

    httpRequestsTotal.inc({ method: req.method, route, status });
    httpRequestDurationMs.observe({ method: req.method, route, status }, latency);

    logger.info({
      event:         'http_request',
      method:        req.method,
      path:          req.path,
      route,
      status:        res.statusCode,
      latencyMs:     latency,
      correlationId: req.correlationId,
      userAgent:     req.headers['user-agent'],
    });
  });

  next();
}

/**
 * Global error handler — maps domain errors to HTTP status codes.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.statusCode || 500;

  logger.error({
    event:         'unhandled_error',
    code:          err.code,
    message:       err.message,
    stack:         status >= 500 ? err.stack : undefined,
    path:          req.path,
    method:        req.method,
    correlationId: req.correlationId,
  });

  res.status(status).json({
    success: false,
    error:   err.message,
    code:    err.code || 'INTERNAL_ERROR',
    correlationId: req.correlationId,
  });
}

module.exports = { correlationId, requestLogger, errorHandler };
