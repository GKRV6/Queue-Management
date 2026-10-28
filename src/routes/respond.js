'use strict';

/** Consistent response envelope: { success, data, error }. */
function ok(res, data, status = 200) {
  res.status(status).json({ success: true, data: data ?? null, error: null });
}

module.exports = { ok };
