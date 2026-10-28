'use strict';

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new AppError(400, msg);
const unauthorized = (msg = 'Please log in to continue') => new AppError(401, msg);
const forbidden = (msg = 'You do not have access to this resource') => new AppError(403, msg);
const notFound = (msg = 'Not found') => new AppError(404, msg);
const conflict = (msg) => new AppError(409, msg);

// Friendly messages for constraint violations raised by SQLite itself
const CONSTRAINT_MESSAGES = [
  [/ux_tokens_one_live_per_user|queue_tokens\.queue_id, queue_tokens\.user_id/, 'You already hold a live token in this queue'],
  [/ux_tokens_one_active_per_counter|queue_tokens\.counter_id/, 'This counter is already handling a token'],
  [/users\.email/, 'An account with this email already exists'],
  [/service_centers\.name/, 'A service center with this name already exists'],
  [/service_types\.center_id, service_types\.name/, 'This center already has a service with that name'],
  [/service_types\.center_id, service_types\.code/, 'This center already uses that token code'],
  [/counters\.center_id, counters\.counter_number/, 'This center already has a counter with that number'],
  [/service_staff\.counter_id/, 'That counter is already assigned to another staff member'],
  [/time_slots\.center_id, time_slots\.start_time/, 'A time slot starting at that time already exists'],
  [/feedback\.token_id/, 'Feedback was already submitted for this token'],
  [/FOREIGN KEY constraint failed/, 'The referenced record does not exist or is still in use'],
  [/CHECK constraint failed/, 'One of the values is outside the allowed range'],
];

/**
 * Converts any thrown error into { status, message } suitable for an API response.
 * Trigger messages are prefixed with "QWS:" and passed through verbatim.
 */
function toHttpError(err) {
  if (err instanceof AppError) return { status: err.status, message: err.message };
  const text = String(err && err.message ? err.message : err);
  const triggerMsg = text.match(/QWS:\s*(.+)$/);
  if (triggerMsg) return { status: 409, message: triggerMsg[1].trim() };
  if (err && err.code === 'ERR_SQLITE_ERROR') {
    for (const [pattern, message] of CONSTRAINT_MESSAGES) {
      if (pattern.test(text)) return { status: 409, message };
    }
  }
  return { status: 500, message: 'Something went wrong. Please try again.' };
}

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, toHttpError };
