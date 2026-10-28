'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, parseId } = require('../src/validate');
const auth = require('../src/auth');
const { toHttpError, AppError } = require('../src/errors');
const { loadReportQueries } = require('../src/db');

test('validate coerces and checks every rule type', () => {
  const out = validate(
    { name: '  Ann  ', n: '4', f: '2.5', b: 'true', e: 'A@B.CO', t: '09:30', p: '98765 43210', ids: ['1', 2], role: 'staff' },
    {
      name: { type: 'string', min: 2 }, n: { type: 'int', min: 1 }, f: { type: 'number' }, b: { type: 'bool' },
      e: { type: 'email' }, t: { type: 'time' }, p: { type: 'phone' }, ids: { type: 'intArray' },
      role: { type: 'enum', values: ['staff'] }, missing: { type: 'int', default: 7 }, skipped: { type: 'string' },
    },
  );
  assert.deepEqual(out, { name: 'Ann', n: 4, f: 2.5, b: 1, e: 'a@b.co', t: '09:30', p: '9876543210', ids: [1, 2], role: 'staff', missing: 7 });

  const bad = [
    [{ x: '' }, { x: { type: 'string', required: true } }, /required/],
    [{ x: 'a' }, { x: { type: 'string', min: 2 } }, /at least 2/],
    [{ x: 'abcd' }, { x: { type: 'string', max: 2 } }, /at most 2/],
    [{ x: '1.5' }, { x: { type: 'int' } }, /whole number/],
    [{ x: 'NaN' }, { x: { type: 'number' } }, /number/],
    [{ x: 0 }, { x: { type: 'int', min: 1 } }, /at least 1/],
    [{ x: 9 }, { x: { type: 'int', max: 5 } }, /at most 5/],
    [{ x: 'maybe' }, { x: { type: 'bool' } }, /true or false/],
    [{ x: 'z' }, { x: { type: 'enum', values: ['a'] } }, /one of/],
    [{ x: '25:00' }, { x: { type: 'time' } }, /HH:MM/],
    [{ x: 'nope' }, { x: { type: 'email' } }, /valid email/],
    [{ x: '12' }, { x: { type: 'phone' } }, /phone/],
    [{ x: 'a' }, { x: { type: 'intArray' } }, /list/],
    [{ x: [0] }, { x: { type: 'intArray' } }, /valid ids/],
  ];
  for (const [input, rules, pattern] of bad) assert.throws(() => validate(input, rules), pattern);
  assert.throws(() => validate({ x: 1 }, { x: { type: 'weird' } }), /Unknown validation type/);
  assert.deepEqual(validate(null, {}), {});
  assert.equal(parseId('12'), 12);
  assert.throws(() => parseId('-1'), /Invalid id/);
});

test('password hashing and verification', () => {
  const hash = auth.hashPassword('secret123');
  assert.match(hash, /^scrypt\$/);
  assert.ok(auth.verifyPassword('secret123', hash));
  assert.ok(!auth.verifyPassword('secret124', hash));
  assert.ok(!auth.verifyPassword('x', 'plain-text'));
});

test('session tokens are signed and expire', () => {
  const now = Date.now();
  const token = auth.createSessionToken(42, now);
  assert.equal(auth.readSessionToken(token, now), 42);
  assert.equal(auth.readSessionToken(token, now + 13 * 60 * 60 * 1000), null);
  const [id, exp, sig] = token.split('.');
  assert.equal(auth.readSessionToken(`43.${exp}.${sig}`, now), null, 'tampered user id');
  assert.equal(auth.readSessionToken(`${id}.${exp}`, now), null);
  assert.equal(auth.readSessionToken(undefined, now), null);
  assert.match(auth.sessionCookie(token), /HttpOnly; SameSite=Lax/);
  assert.match(auth.clearedSessionCookie(), /Max-Age=0/);
});

test('requireRole and rateLimit middleware', () => {
  const run = (mw, req) => {
    let result = 'next';
    const res = { status: (code) => ({ json: () => { result = code; } }) };
    mw(req, res, (err) => { if (err) result = err.status; });
    return result;
  };
  assert.equal(run(auth.requireRole('admin'), { user: null }), 401);
  assert.equal(run(auth.requireRole('admin'), { user: { role: 'customer' } }), 403);
  assert.equal(run(auth.requireRole('admin'), { user: { role: 'admin' } }), 'next');
  assert.equal(run(auth.requireRole(), { user: { role: 'staff' } }), 'next');

  const limiter = auth.rateLimit({ windowMs: 60000, max: 2 });
  const req = { ip: '1.2.3.4' };
  assert.equal(run(limiter, req), 'next');
  assert.equal(run(limiter, req), 'next');
  assert.equal(run(limiter, req), 429);
});

test('toHttpError maps trigger and constraint errors to friendly messages', () => {
  const sqlite = (message) => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR' });
  assert.deepEqual(toHttpError(new AppError(404, 'Gone')), { status: 404, message: 'Gone' });
  assert.deepEqual(toHttpError(sqlite('QWS: Queue is full')), { status: 409, message: 'Queue is full' });
  assert.equal(toHttpError(sqlite('UNIQUE constraint failed: users.email')).message, 'An account with this email already exists');
  assert.equal(toHttpError(sqlite('CHECK constraint failed: x')).status, 409);
  assert.equal(toHttpError(sqlite('disk I/O error')).status, 500);
  assert.equal(toHttpError(new Error('boom')).status, 500);
});

test('report queries are parsed from db/queries.sql', () => {
  const reports = loadReportQueries();
  assert.ok(reports.length >= 15);
  for (const r of reports) {
    assert.match(r.name, /^[a-z_]+$/);
    assert.ok(r.title && r.description && r.concepts, `metadata for ${r.name}`);
    assert.match(r.sql, /^(SELECT|WITH)/);
    assert.ok(!r.sql.trim().endsWith(';'));
  }
});
