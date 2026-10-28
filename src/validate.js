'use strict';

const { badRequest } = require('./errors');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?\d{7,14}$/;

/**
 * Tiny declarative validator for request bodies.
 * rules: { field: { type, required, min, max, values, label } }
 * Returns a new object containing only the declared, validated fields.
 */
function validate(input, rules) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [field, rule] of Object.entries(rules)) {
    const label = rule.label || field;
    let value = source[field];
    if (typeof value === 'string' && rule.trim !== false) value = value.trim();
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (rule.required) throw badRequest(`${label} is required`);
      if (rule.default !== undefined) out[field] = rule.default;
      continue;
    }
    out[field] = coerce(value, rule, label);
  }
  return out;
}

function coerce(value, rule, label) {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${label} must be text`);
      const s = String(value);
      if (rule.min !== undefined && s.length < rule.min) throw badRequest(`${label} must be at least ${rule.min} characters`);
      if (rule.max !== undefined && s.length > rule.max) throw badRequest(`${label} must be at most ${rule.max} characters`);
      return s;
    }
    case 'int':
    case 'number': {
      const n = Number(value);
      const ok = rule.type === 'int' ? Number.isInteger(n) : Number.isFinite(n);
      if (!ok) throw badRequest(`${label} must be a ${rule.type === 'int' ? 'whole ' : ''}number`);
      if (rule.min !== undefined && n < rule.min) throw badRequest(`${label} must be at least ${rule.min}`);
      if (rule.max !== undefined && n > rule.max) throw badRequest(`${label} must be at most ${rule.max}`);
      return n;
    }
    case 'bool':
      if (value === true || value === 1 || value === '1' || value === 'true') return 1;
      if (value === false || value === 0 || value === '0' || value === 'false') return 0;
      throw badRequest(`${label} must be true or false`);
    case 'enum':
      if (!rule.values.includes(value)) throw badRequest(`${label} must be one of: ${rule.values.join(', ')}`);
      return value;
    case 'time':
      if (!TIME_RE.test(value)) throw badRequest(`${label} must be a time in HH:MM format`);
      return value;
    case 'email': {
      const s = String(value).toLowerCase();
      if (!EMAIL_RE.test(s) || s.length > 120) throw badRequest(`${label} must be a valid email address`);
      return s;
    }
    case 'phone': {
      const s = String(value).replace(/[\s-]/g, '');
      if (!PHONE_RE.test(s)) throw badRequest(`${label} must be a valid phone number`);
      return s;
    }
    case 'intArray': {
      if (!Array.isArray(value)) throw badRequest(`${label} must be a list`);
      return value.map((v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw badRequest(`${label} must contain valid ids`);
        return n;
      });
    }
    default:
      throw new Error(`Unknown validation type ${rule.type}`);
  }
}

function parseId(value, label = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${label}`);
  return n;
}

module.exports = { validate, parseId };
