'use strict';

const crypto = require('node:crypto');
const { unauthorized, forbidden } = require('./errors');

const SESSION_COOKIE = 'qws_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 32;

// Sessions are signed with SESSION_SECRET; a random secret is used when it is
// not configured, which simply logs everyone out on restart.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

// Used when an email is unknown so a login takes the same time either way.
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(SCRYPT_KEYLEN * 2)}`;

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function createSessionToken(userId, now = Date.now()) {
  const payload = `${userId}.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

function readSessionToken(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const userId = Number(parts[0]);
  const expires = Number(parts[1]);
  if (!Number.isInteger(userId) || !(expires > now)) return null;
  return userId;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    try {
      cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // a malformed cookie set by another app on the same host is ignored, not fatal
    }
  }
  return cookies;
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Express middleware: attaches req.user (or null) from the session cookie. */
function loadUser(db) {
  const stmt = db.prepare(
    'SELECT user_id, full_name, email, phone, role, is_active FROM users WHERE user_id = ?'
  );
  return (req, _res, next) => {
    const userId = readSessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    const user = userId ? stmt.get(userId) : null;
    req.user = user && user.is_active ? { ...user } : null;
    next();
  };
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (roles.length && !roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Very small fixed-window rate limiter (per IP) for the login endpoint. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.status(429).json({ success: false, data: null, error: 'Too many attempts. Please wait a minute and try again.' });
      return;
    }
    hits.set(key, { count: entry.count + 1, resetAt: entry.resetAt });
    next();
  };
}

module.exports = {
  DUMMY_HASH,
  hashPassword,
  verifyPassword,
  createSessionToken,
  readSessionToken,
  sessionCookie,
  clearedSessionCookie,
  loadUser,
  requireRole,
  rateLimit,
};
