'use strict';

const express = require('express');
const {
  hashPassword, verifyPassword, createSessionToken, sessionCookie, clearedSessionCookie, rateLimit, requireRole, DUMMY_HASH,
} = require('../auth');
const { validate } = require('../validate');
const { unauthorized } = require('../errors');
const { ok } = require('./respond');

const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function publicUser(u) {
  return { user_id: u.user_id, full_name: u.full_name, email: u.email, phone: u.phone, role: u.role };
}

module.exports = function authRoutes(db, { loginMaxAttempts = LOGIN_MAX_ATTEMPTS } = {}) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: loginMaxAttempts });

  router.post('/register', limiter, (req, res) => {
    const input = validate(req.body, {
      fullName: { type: 'string', required: true, min: 2, max: 100, label: 'Full name' },
      email: { type: 'email', required: true, label: 'Email' },
      phone: { type: 'phone', label: 'Phone' },
      password: { type: 'string', required: true, min: 8, max: 72, trim: false, label: 'Password' },
    });
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'customer')`)
      .run(input.fullName, input.email, input.phone ?? null, hashPassword(input.password));
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(lastInsertRowid);
    res.setHeader('Set-Cookie', sessionCookie(createSessionToken(user.user_id)));
    ok(res, publicUser(user), 201);
  });

  router.post('/login', limiter, (req, res) => {
    const input = validate(req.body, {
      email: { type: 'email', required: true, label: 'Email' },
      password: { type: 'string', required: true, max: 72, trim: false, label: 'Password' },
    });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email);
    const passwordOk = verifyPassword(input.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !passwordOk) throw unauthorized('Incorrect email or password');
    if (!user.is_active) throw unauthorized('This account has been deactivated');
    res.setHeader('Set-Cookie', sessionCookie(createSessionToken(user.user_id)));
    ok(res, publicUser(user));
  });

  router.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedSessionCookie());
    ok(res, null);
  });

  router.get('/me', requireRole(), (req, res) => ok(res, publicUser(req.user)));

  return router;
};
