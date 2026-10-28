'use strict';

const { transaction } = require('../db');
const { badRequest, notFound, forbidden, conflict } = require('../errors');

// A customer gets a "your turn is near" alert once they are this close to the front.
const TURN_NEAR_POSITION = 3;
// Stops one account from exhausting a queue (or flooding notifications) by joining and cancelling in a loop.
const MAX_TOKENS_PER_USER_PER_DAY = 15;
const LIVE_STATUSES = ['waiting', 'called', 'serving', 'skipped'];

const TOKEN_VIEW_SQL = `
  SELECT d.*, e.position, e.est_wait_minutes, e.is_eligible, e.eligible_at
  FROM v_token_details d
  LEFT JOIN v_token_eta e ON e.token_id = d.token_id`;

function getTokenView(db, tokenId) {
  return db.prepare(`${TOKEN_VIEW_SQL} WHERE d.token_id = ?`).get(tokenId) || null;
}

/**
 * Day rollover: queues of earlier days that were never closed are closed now,
 * and their tokens still waiting (or skipped/called) are cancelled, so no
 * customer is left holding a ghost ticket from yesterday.
 */
function closeStaleQueues(db) {
  const stale = db.prepare(`
    SELECT queue_id FROM queues WHERE queue_date < date('now', 'localtime') AND status <> 'closed'`).all();
  for (const { queue_id: queueId } of stale) {
    db.prepare(`
      UPDATE queue_tokens SET status = 'cancelled', updated_at = datetime('now', 'localtime'), updated_by = NULL
      WHERE queue_id = ? AND status IN ('waiting', 'called', 'skipped')`).run(queueId);
    db.prepare(`
      UPDATE queues SET status = 'closed', closed_at = datetime('now', 'localtime') WHERE queue_id = ?`).run(queueId);
  }
  return stale.length;
}

/** Today's queue for a service type, created on first use. */
function getOrCreateTodayQueue(db, serviceTypeId) {
  const existing = db
    .prepare("SELECT * FROM queues WHERE service_type_id = ? AND queue_date = date('now', 'localtime')")
    .get(serviceTypeId);
  if (existing) return existing;
  const { lastInsertRowid } = db
    .prepare("INSERT INTO queues (service_type_id, queue_date) VALUES (?, date('now', 'localtime'))")
    .run(serviceTypeId);
  return db.prepare('SELECT * FROM queues WHERE queue_id = ?').get(lastInsertRowid);
}

/** Alert customers who have moved into the first few places of a queue (once per token). */
function notifyTurnNear(db, queueId) {
  db.prepare(`
    INSERT INTO notifications (user_id, token_id, type, message)
    SELECT w.user_id, w.token_id, 'turn_near',
           'Your token ' || d.token_code || ' is now #' || w.position || ' in line at '
             || d.center_name || '. Please start heading to the counter.'
    FROM v_waiting_tokens w
    JOIN v_token_details d ON d.token_id = w.token_id
    WHERE w.queue_id = ?
      AND w.is_eligible = 1
      AND w.position <= ?
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.token_id = w.token_id AND n.type = 'turn_near')
  `).run(queueId, TURN_NEAR_POSITION);
}

// ---------------------------------------------------------------------------
// Customer operations
// ---------------------------------------------------------------------------

/**
 * Issues a new token. Runs as one IMMEDIATE transaction so the token number
 * (MAX + 1) can never be handed out twice, and so the admission checks done
 * by trigger trg_tokens_validate_insert see a consistent snapshot.
 */
function joinQueue(db, userId, { serviceTypeId, slotId = null, notes = null }) {
  return transaction(db, () => {
    closeStaleQueues(db);
    const { issued } = db.prepare(`
      SELECT COUNT(*) AS issued FROM queue_tokens t JOIN queues q ON q.queue_id = t.queue_id
      WHERE t.user_id = ? AND q.queue_date = date('now', 'localtime')`).get(userId);
    if (issued >= MAX_TOKENS_PER_USER_PER_DAY) {
      throw conflict(`You can take at most ${MAX_TOKENS_PER_USER_PER_DAY} tokens per day`);
    }
    const service = db.prepare(`
      SELECT st.service_type_id, st.is_active, st.center_id, sc.is_active AS center_active
      FROM service_types st
      JOIN service_centers sc ON sc.center_id = st.center_id
      WHERE st.service_type_id = ?`).get(serviceTypeId);
    if (!service) throw notFound('Service not found');
    if (!service.is_active || !service.center_active) throw conflict('This service is not available at the moment');

    if (slotId !== null) {
      const slot = db.prepare(`
        SELECT slot_id, end_time > strftime('%H:%M', 'now', 'localtime') AS bookable
        FROM time_slots WHERE slot_id = ? AND center_id = ?`).get(slotId, service.center_id);
      if (!slot) throw badRequest('The selected time slot does not belong to this service center');
      if (!slot.bookable) throw conflict('That time slot has already ended today');
    }

    const queue = getOrCreateTodayQueue(db, serviceTypeId);
    const { next } = db
      .prepare('SELECT COALESCE(MAX(token_number), 0) + 1 AS next FROM queue_tokens WHERE queue_id = ?')
      .get(queue.queue_id);

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO queue_tokens (queue_id, user_id, token_number, slot_id, notes, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)`).run(queue.queue_id, userId, next, slotId, notes, userId);

    notifyTurnNear(db, queue.queue_id);
    return getTokenView(db, Number(lastInsertRowid));
  });
}

function cancelToken(db, userId, tokenId) {
  return transaction(db, () => {
    const token = db.prepare('SELECT * FROM queue_tokens WHERE token_id = ?').get(tokenId);
    if (!token || token.user_id !== userId) throw notFound('Token not found');
    if (!['waiting', 'called', 'skipped'].includes(token.status)) {
      throw conflict(`A token that is ${token.status.replace('_', '-')} cannot be cancelled`);
    }
    updateTokenStatus(db, tokenId, 'cancelled', userId);
    notifyTurnNear(db, token.queue_id);
    return getTokenView(db, tokenId);
  });
}

function getActiveTokens(db, userId) {
  const placeholders = LIVE_STATUSES.map(() => '?').join(', ');
  return db
    .prepare(`${TOKEN_VIEW_SQL} WHERE d.user_id = ? AND d.status IN (${placeholders})
              AND d.queue_date = date('now', 'localtime') ORDER BY d.issued_at`)
    .all(userId, ...LIVE_STATUSES);
}

function getTokenHistory(db, userId, limit = 50) {
  return db.prepare(`
    SELECT d.token_id, d.token_code, d.status, d.issued_at, d.updated_at, d.queue_date,
           d.service_name, d.center_name, d.counter_label,
           tt.wait_minutes, tt.service_minutes,
           f.rating, f.comment AS feedback_comment
    FROM v_token_details d
    JOIN v_token_timings tt ON tt.token_id = d.token_id
    LEFT JOIN feedback f    ON f.token_id = d.token_id
    WHERE d.user_id = ? AND d.status IN ('completed', 'cancelled', 'no_show')
    ORDER BY d.issued_at DESC
    LIMIT ?`).all(userId, limit);
}

function getTokenTimeline(db, tokenId, user) {
  const token = db.prepare(`
    SELECT t.user_id, st.center_id FROM queue_tokens t
    JOIN queues q ON q.queue_id = t.queue_id
    JOIN service_types st ON st.service_type_id = q.service_type_id
    WHERE t.token_id = ?`).get(tokenId);
  const allowed = token && (
    user.role === 'admin'
    || (user.role === 'customer' && token.user_id === user.user_id)
    || (user.role === 'staff' && getStaffContext(db, user.user_id).center_id === token.center_id));
  if (!allowed) throw notFound('Token not found');
  return db.prepare(`
    SELECT h.from_status, h.to_status, h.changed_at, COALESCE(u.full_name, 'system') AS changed_by
    FROM queue_status_history h
    LEFT JOIN users u ON u.user_id = h.changed_by
    WHERE h.token_id = ?
    ORDER BY h.history_id`).all(tokenId);
}

function submitFeedback(db, userId, tokenId, { rating, comment = null }) {
  const token = db.prepare('SELECT user_id FROM queue_tokens WHERE token_id = ?').get(tokenId);
  if (!token || token.user_id !== userId) throw notFound('Token not found');
  db.prepare('INSERT INTO feedback (token_id, rating, comment) VALUES (?, ?, ?)').run(tokenId, rating, comment);
  return db.prepare('SELECT * FROM feedback WHERE token_id = ?').get(tokenId);
}

// ---------------------------------------------------------------------------
// Staff operations
// ---------------------------------------------------------------------------

function getStaffContext(db, userId) {
  const ctx = db.prepare(`
    SELECT ss.staff_id, ss.user_id, ss.center_id, ss.counter_id, ss.designation,
           (ss.counter_id IS NOT NULL AND c.status <> 'closed') AS is_on_duty,
           sc.name AS center_name, c.label AS counter_label, c.status AS counter_status, c.counter_number
    FROM service_staff ss
    JOIN service_centers sc ON sc.center_id = ss.center_id
    LEFT JOIN counters c    ON c.counter_id = ss.counter_id
    WHERE ss.user_id = ?`).get(userId);
  if (!ctx) throw forbidden('No staff profile is linked to this account');
  return ctx;
}

function requireCounter(ctx) {
  if (!ctx.counter_id) throw conflict('You are not assigned to a counter. Ask an administrator to assign one.');
  return ctx;
}

function updateTokenStatus(db, tokenId, status, actorId, extra = {}) {
  const sets = ['status = ?', "updated_at = datetime('now', 'localtime')", 'updated_by = ?'];
  const params = [status, actorId];
  if ('counterId' in extra) {
    sets.push('counter_id = ?');
    params.push(extra.counterId);
  }
  db.prepare(`UPDATE queue_tokens SET ${sets.join(', ')} WHERE token_id = ?`).run(...params, tokenId);
}

function currentCounterToken(db, counterId) {
  return db.prepare(`
    SELECT token_id FROM queue_tokens
    WHERE counter_id = ? AND status IN ('called', 'serving')`).get(counterId) || null;
}

/** Picks the next eligible token among all service types this counter handles. */
function callNext(db, userId) {
  return transaction(db, () => {
    const ctx = requireCounter(getStaffContext(db, userId));
    if (ctx.counter_status !== 'open') throw conflict('Open your counter before calling tokens');
    if (currentCounterToken(db, ctx.counter_id)) {
      throw conflict('Finish, skip or mark the current token before calling the next one');
    }
    const next = db.prepare(`
      SELECT w.token_id, w.queue_id
      FROM v_waiting_tokens w
      JOIN counter_services cs ON cs.service_type_id = w.service_type_id AND cs.counter_id = ?
      JOIN queues q            ON q.queue_id = w.queue_id
      WHERE w.queue_date = date('now', 'localtime')
        AND w.is_eligible = 1
        AND q.status <> 'closed'
      ORDER BY (w.priority = 'priority') DESC, w.eligible_at, w.token_id
      LIMIT 1`).get(ctx.counter_id);
    if (!next) return null;

    updateTokenStatus(db, next.token_id, 'called', userId, { counterId: ctx.counter_id });
    notifyTurnNear(db, next.queue_id);
    return getTokenView(db, next.token_id);
  });
}

/** Loads a token and checks it belongs to the staff member's center (and counter, if required). */
function loadStaffToken(db, ctx, tokenId, { atCounter }) {
  const token = db.prepare(`
    SELECT t.*, st.center_id
    FROM queue_tokens t
    JOIN queues q         ON q.queue_id = t.queue_id
    JOIN service_types st ON st.service_type_id = q.service_type_id
    WHERE t.token_id = ?`).get(tokenId);
  if (!token || token.center_id !== ctx.center_id) throw notFound('Token not found at your service center');
  if (atCounter && token.counter_id !== ctx.counter_id) throw conflict('This token is assigned to a different counter');
  return token;
}

function expectStatus(token, ...allowed) {
  if (!allowed.includes(token.status)) {
    throw conflict(`Token is ${token.status.replace('_', '-')}; expected ${allowed.join(' or ')}`);
  }
}

function startServing(db, userId, tokenId) {
  return transaction(db, () => {
    const ctx = requireCounter(getStaffContext(db, userId));
    const token = loadStaffToken(db, ctx, tokenId, { atCounter: true });
    expectStatus(token, 'called');
    updateTokenStatus(db, tokenId, 'serving', userId);
    db.prepare(`
      INSERT INTO service_records (token_id, staff_id, counter_id, started_at)
      VALUES (?, ?, ?, datetime('now', 'localtime'))`).run(tokenId, ctx.staff_id, ctx.counter_id);
    return getTokenView(db, tokenId);
  });
}

function completeToken(db, userId, tokenId, { remarks = null } = {}) {
  return transaction(db, () => {
    const ctx = requireCounter(getStaffContext(db, userId));
    const token = loadStaffToken(db, ctx, tokenId, { atCounter: true });
    expectStatus(token, 'serving');
    updateTokenStatus(db, tokenId, 'completed', userId);
    db.prepare(`
      UPDATE service_records SET ended_at = datetime('now', 'localtime'), remarks = ?
      WHERE token_id = ?`).run(remarks, tokenId);
    return getTokenView(db, tokenId);
  });
}

function skipToken(db, userId, tokenId) {
  return transaction(db, () => {
    const ctx = requireCounter(getStaffContext(db, userId));
    const token = loadStaffToken(db, ctx, tokenId, { atCounter: true });
    expectStatus(token, 'called');
    updateTokenStatus(db, tokenId, 'skipped', userId);
    return getTokenView(db, tokenId);
  });
}

function markNoShow(db, userId, tokenId) {
  return transaction(db, () => {
    const ctx = getStaffContext(db, userId);
    const token = loadStaffToken(db, ctx, tokenId, { atCounter: false });
    expectStatus(token, 'called', 'skipped');
    updateTokenStatus(db, tokenId, 'no_show', userId);
    return getTokenView(db, tokenId);
  });
}

/** A skipped customer who turns up goes back into the line, keeping their original number. */
function requeueToken(db, userId, tokenId) {
  return transaction(db, () => {
    const ctx = getStaffContext(db, userId);
    const token = loadStaffToken(db, ctx, tokenId, { atCounter: false });
    expectStatus(token, 'skipped');
    const { status } = db.prepare('SELECT status FROM queues WHERE queue_id = ?').get(token.queue_id);
    if (status === 'closed') throw conflict('This queue is closed; the token cannot be re-queued');
    updateTokenStatus(db, tokenId, 'waiting', userId, { counterId: null });
    notifyTurnNear(db, token.queue_id);
    return getTokenView(db, tokenId);
  });
}

function prioritizeToken(db, userId, tokenId) {
  return transaction(db, () => {
    const ctx = getStaffContext(db, userId);
    const token = loadStaffToken(db, ctx, tokenId, { atCounter: false });
    expectStatus(token, 'waiting');
    db.prepare(`
      UPDATE queue_tokens
      SET priority = 'priority', updated_at = datetime('now', 'localtime'), updated_by = ?
      WHERE token_id = ?`).run(userId, tokenId);
    notifyTurnNear(db, token.queue_id);
    return getTokenView(db, tokenId);
  });
}

function setCounterStatus(db, userId, status) {
  return transaction(db, () => {
    const ctx = requireCounter(getStaffContext(db, userId));
    if (status !== 'open' && currentCounterToken(db, ctx.counter_id)) {
      throw conflict('Finish or skip the token at your counter before pausing or closing it');
    }
    db.prepare('UPDATE counters SET status = ? WHERE counter_id = ?').run(status, ctx.counter_id);
    return getStaffContext(db, userId);
  });
}

/**
 * Opens, pauses or closes a queue. Closing a queue cancels every token that
 * is still waiting (or skipped) in the same transaction; the status trigger
 * notifies each affected customer.
 *   paused  -> no new tokens accepted, existing tokens are still served
 *   closed  -> queue finished for the day
 */
function setQueueStatus(db, actor, queueId, status) {
  return transaction(db, () => {
    const queue = db.prepare(`
      SELECT q.*, st.center_id FROM queues q
      JOIN service_types st ON st.service_type_id = q.service_type_id
      WHERE q.queue_id = ?`).get(queueId);
    if (!queue) throw notFound('Queue not found');
    if (actor.role === 'staff' && getStaffContext(db, actor.user_id).center_id !== queue.center_id) {
      throw forbidden('You can only manage queues of your own service center');
    }
    if (queue.status === status) return queue;

    if (status === 'closed') {
      db.prepare(`
        UPDATE queues SET status = 'closed', closed_at = datetime('now', 'localtime') WHERE queue_id = ?`).run(queueId);
      db.prepare(`
        UPDATE queue_tokens
        SET status = 'cancelled', updated_at = datetime('now', 'localtime'), updated_by = ?
        WHERE queue_id = ? AND status IN ('waiting', 'skipped')`).run(actor.user_id, queueId);
    } else {
      db.prepare('UPDATE queues SET status = ?, closed_at = NULL WHERE queue_id = ?').run(status, queueId);
    }
    return db.prepare('SELECT * FROM queues WHERE queue_id = ?').get(queueId);
  });
}

module.exports = {
  TURN_NEAR_POSITION,
  MAX_TOKENS_PER_USER_PER_DAY,
  closeStaleQueues,
  getTokenView,
  getOrCreateTodayQueue,
  joinQueue,
  cancelToken,
  getActiveTokens,
  getTokenHistory,
  getTokenTimeline,
  submitFeedback,
  getStaffContext,
  callNext,
  startServing,
  completeToken,
  skipToken,
  markNoShow,
  requeueToken,
  prioritizeToken,
  setCounterStatus,
  setQueueStatus,
};
