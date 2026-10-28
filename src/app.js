'use strict';

const path = require('node:path');
const express = require('express');
const { loadUser } = require('./auth');
const { toHttpError, AppError } = require('./errors');
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customer');
const staffRoutes = require('./routes/staff');
const adminRoutes = require('./routes/admin');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'"
  );
  next();
}

/**
 * CSRF guard: browsers cannot send a cross-site application/json request
 * without a CORS preflight, which this server never approves.
 */
function requireJsonForMutations(req, _res, next) {
  if (MUTATING_METHODS.has(req.method) && !req.is('application/json')) {
    return next(new AppError(415, 'Requests must be sent as JSON'));
  }
  next();
}

/**
 * options.loginMaxAttempts - login/register attempts per IP per minute (default 10)
 */
function createApp(db, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '50kb' }));

  const api = express.Router();
  api.use(requireJsonForMutations);
  api.use(loadUser(db));
  api.use('/auth', authRoutes(db, options));
  api.use('/staff', staffRoutes(db));
  api.use('/admin', adminRoutes(db));
  api.use('/', customerRoutes(db));
  api.use((_req, _res, next) => next(new AppError(404, 'API endpoint not found')));
  app.use('/api', api);

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, data: null, error: 'Malformed JSON body' });
    }
    const { status, message } = toHttpError(err);
    if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(status).json({ success: false, data: null, error: message });
  });

  return app;
}

module.exports = { createApp };
