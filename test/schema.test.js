'use strict';

// Integrity rules enforced by the database itself (constraints, indexes, triggers).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, expectDbError } = require('./fixtures');

function openQueue(db, serviceTypeId, status = 'open') {
  return Number(db.prepare(`
    INSERT INTO queues (service_type_id, queue_date, status, closed_at)
    VALUES (?, date('now', 'localtime'), ?, CASE WHEN ? = 'closed' THEN datetime('now', 'localtime') END)`)
    .run(serviceTypeId, status, status).lastInsertRowid);
}

function insertToken(db, queueId, userId, number, extra = {}) {
  return Number(db.prepare(`
    INSERT INTO queue_tokens (queue_id, user_id, token_number, slot_id) VALUES (?, ?, ?, ?)`)
    .run(queueId, userId, number, extra.slotId ?? null).lastInsertRowid);
}

test('CHECK and UNIQUE constraints reject invalid rows', () => {
  const { db, ids } = createFixture();
  expectDbError(assert, () => db.prepare(`
    INSERT INTO users (full_name, email, password_hash, role) VALUES ('X Y', 'ALICE@test.edu', 'h', 'customer')`).run(),
  /UNIQUE constraint failed: users.email/);
  expectDbError(assert, () => db.prepare(`
    INSERT INTO users (full_name, email, password_hash, role) VALUES ('X Y', 'x@test.edu', 'h', 'superuser')`).run(),
  /CHECK constraint failed/);
  expectDbError(assert, () => db.prepare(`
    INSERT INTO service_centers (name, category, location, opening_time, closing_time) VALUES ('Late', 'canteen', 'L', '18:00', '09:00')`).run(),
  /CHECK constraint failed/);
  expectDbError(assert, () => db.prepare(`
    INSERT INTO service_types (center_id, name, code, avg_service_minutes) VALUES (?, 'Juice', 'm1', 2)`).run(ids.canteen),
  /CHECK constraint failed/);
  expectDbError(assert, () => db.prepare(`
    INSERT INTO service_types (center_id, name, code, avg_service_minutes) VALUES (?, 'Juice', 'M', 2)`).run(ids.canteen),
  /UNIQUE constraint failed: service_types.center_id, service_types.code/);
  expectDbError(assert, () => db.prepare(`
    INSERT INTO counters (center_id, counter_number, label) VALUES (?, 1, 'Dup')`).run(ids.canteen),
  /UNIQUE constraint failed/);
});

test('foreign keys are enforced', () => {
  const { db, ids } = createFixture();
  expectDbError(assert, () => db.prepare(`
    INSERT INTO service_types (center_id, name, code, avg_service_minutes) VALUES (999, 'Ghost', 'G', 2)`).run(),
  /FOREIGN KEY constraint failed/);
  const queueId = openQueue(db, ids.meals);
  insertToken(db, queueId, ids.alice, 1);
  // a user with tokens cannot be deleted (ON DELETE RESTRICT)
  expectDbError(assert, () => db.prepare('DELETE FROM users WHERE user_id = ?').run(ids.alice), /FOREIGN KEY constraint failed/);
});

test('counter_services trigger keeps counters and services in the same center', () => {
  const { db, ids } = createFixture();
  expectDbError(assert, () => db.prepare('INSERT INTO counter_services VALUES (?, ?)').run(ids.counterA, ids.consult),
    /same service center/);
});

test('service_staff triggers require staff role and a counter of the same center', () => {
  const { db, ids } = createFixture();
  expectDbError(assert, () => db.prepare(`
    INSERT INTO service_staff (user_id, center_id, designation) VALUES (?, ?, 'X')`).run(ids.carol, ids.canteen),
  /staff role/);
  expectDbError(assert, () => db.prepare('UPDATE service_staff SET counter_id = ? WHERE staff_id = ?').run(ids.counterC, ids.staffARow),
    /different service center/);
});

test('token insert trigger blocks closed queues and full time slots', () => {
  const { db, ids } = createFixture();
  const closed = openQueue(db, ids.meals, 'closed');
  expectDbError(assert, () => insertToken(db, closed, ids.alice, 1), /not accepting new tokens/);

  const snacks = openQueue(db, ids.snacks);
  insertToken(db, snacks, ids.alice, 1, { slotId: ids.futureSlot });
  expectDbError(assert, () => insertToken(db, snacks, ids.bob, 2, { slotId: ids.futureSlot }), /fully booked/);
  expectDbError(assert, () => insertToken(db, snacks, ids.bob, 2, { slotId: ids.clinicSlot }), /does not belong/);
});

test('partial unique indexes: one live token per user per queue, one active token per counter', () => {
  const { db, ids } = createFixture();
  const q = openQueue(db, ids.meals);
  const t1 = insertToken(db, q, ids.alice, 1);
  expectDbError(assert, () => insertToken(db, q, ids.alice, 2), /UNIQUE constraint failed: queue_tokens.queue_id, queue_tokens.user_id/);

  // once the first token is finished the same user may join again
  db.prepare("UPDATE queue_tokens SET status = 'cancelled' WHERE token_id = ?").run(t1);
  insertToken(db, q, ids.alice, 2);

  const t3 = insertToken(db, q, ids.bob, 3);
  const t4 = insertToken(db, q, ids.carol, 4);
  db.prepare("UPDATE queue_tokens SET status = 'called', counter_id = ? WHERE token_id = ?").run(ids.counterA, t3);
  expectDbError(assert, () => db.prepare("UPDATE queue_tokens SET status = 'called', counter_id = ? WHERE token_id = ?").run(ids.counterA, t4),
    /UNIQUE constraint failed: queue_tokens.counter_id/);
});

test('status trigger enforces the token state machine', () => {
  const { db, ids } = createFixture();
  const q = openQueue(db, ids.meals);
  const t = insertToken(db, q, ids.alice, 1);
  const set = (status, counter = null) =>
    db.prepare('UPDATE queue_tokens SET status = ?, counter_id = COALESCE(?, counter_id) WHERE token_id = ?').run(status, counter, t);

  expectDbError(assert, () => set('completed'), /Invalid token status transition/);
  expectDbError(assert, () => set('called'), /does not serve that service type/); // no counter bound
  expectDbError(assert, () => set('called', ids.counterB), /does not serve that service type/);
  db.prepare("UPDATE counters SET status = 'paused' WHERE counter_id = ?").run(ids.counterA);
  expectDbError(assert, () => set('called', ids.counterA), /must be open/);
  db.prepare("UPDATE counters SET status = 'open' WHERE counter_id = ?").run(ids.counterA);

  set('called', ids.counterA);
  set('serving');
  expectDbError(assert, () => set('waiting'), /Invalid token status transition/);
  set('completed');
  expectDbError(assert, () => set('cancelled'), /Invalid token status transition/);
  expectDbError(assert, () => db.prepare('UPDATE queue_tokens SET token_number = 9 WHERE token_id = ?').run(t), /identity fields/);
});

test('history and notification triggers record every change', () => {
  const { db, ids } = createFixture();
  const q = openQueue(db, ids.meals);
  const t = insertToken(db, q, ids.alice, 7);
  db.prepare("UPDATE queue_tokens SET status = 'called', counter_id = ?, updated_by = ? WHERE token_id = ?").run(ids.counterA, ids.staffA, t);

  const history = db.prepare('SELECT from_status, to_status, changed_by FROM queue_status_history WHERE token_id = ? ORDER BY history_id').all(t);
  assert.deepEqual(history.map((h) => [h.from_status, h.to_status]), [[null, 'waiting'], ['waiting', 'called']]);
  assert.equal(history[1].changed_by, ids.staffA);

  const notes = db.prepare('SELECT type, message FROM notifications WHERE token_id = ? ORDER BY notification_id').all(t);
  assert.deepEqual(notes.map((n) => n.type), ['token_issued', 'called']);
  assert.match(notes[0].message, /M-007/);
  assert.match(notes[1].message, /Counter A/);
});

test('feedback is only accepted for completed tokens and only once', () => {
  const { db, ids } = createFixture();
  const q = openQueue(db, ids.meals);
  const t = insertToken(db, q, ids.alice, 1);
  expectDbError(assert, () => db.prepare('INSERT INTO feedback (token_id, rating) VALUES (?, 5)').run(t), /completed tokens/);
  for (const [status, counter] of [['called', ids.counterA], ['serving', null], ['completed', null]]) {
    db.prepare('UPDATE queue_tokens SET status = ?, counter_id = COALESCE(?, counter_id) WHERE token_id = ?').run(status, counter, t);
  }
  expectDbError(assert, () => db.prepare('INSERT INTO feedback (token_id, rating) VALUES (?, 6)').run(t), /CHECK constraint failed/);
  db.prepare('INSERT INTO feedback (token_id, rating) VALUES (?, 4)').run(t);
  expectDbError(assert, () => db.prepare('INSERT INTO feedback (token_id, rating) VALUES (?, 3)').run(t), /UNIQUE constraint failed/);
});

test('service record trigger requires a serving token and a counter/staff of its center', () => {
  const { db, ids } = createFixture();
  const q = openQueue(db, ids.meals);
  const t = insertToken(db, q, ids.alice, 1);
  const record = (counter) => db.prepare(`
    INSERT INTO service_records (token_id, staff_id, counter_id, started_at) VALUES (?, ?, ?, datetime('now'))`)
    .run(t, ids.staffARow, counter);
  expectDbError(assert, () => record(ids.counterA), /being served/);
  db.prepare("UPDATE queue_tokens SET status = 'called', counter_id = ? WHERE token_id = ?").run(ids.counterA, t);
  db.prepare("UPDATE queue_tokens SET status = 'serving' WHERE token_id = ?").run(t);
  expectDbError(assert, () => record(ids.counterC), /different service center/);
  record(ids.counterA);
});

test('review hardening: tokens start waiting, links stay in-center, history is append-only', () => {
  const { db, ids } = createFixture();
  const q = openQueue(db, ids.meals);
  expectDbError(assert, () => db.prepare(`
    INSERT INTO queue_tokens (queue_id, user_id, token_number, status) VALUES (?, ?, 1, 'completed')`).run(q, ids.alice),
  /must start in the waiting state/);
  const t = insertToken(db, q, ids.alice, 1);
  expectDbError(assert, () => db.prepare('UPDATE queue_tokens SET slot_id = ? WHERE token_id = ?').run(ids.clinicSlot, t),
    /does not belong/);
  db.prepare("UPDATE queue_tokens SET status = 'called', counter_id = ? WHERE token_id = ?").run(ids.counterA, t);
  expectDbError(assert, () => db.prepare('UPDATE queue_tokens SET counter_id = ? WHERE token_id = ?').run(ids.counterC, t),
    /does not serve/);
  expectDbError(assert, () => db.prepare("UPDATE queue_status_history SET to_status = 'completed'").run(), /append-only/);
  expectDbError(assert, () => db.prepare('DELETE FROM queue_status_history').run(), /append-only/);
  expectDbError(assert, () => db.prepare("UPDATE users SET role = 'customer' WHERE user_id = ?").run(ids.staffA), /staff profile/);
  expectDbError(assert, () => db.prepare('UPDATE counters SET center_id = ? WHERE counter_id = ?').run(ids.clinic, ids.counterA),
    /cannot be moved/);
  expectDbError(assert, () => db.prepare('DELETE FROM service_types WHERE service_type_id = ?').run(ids.meals),
    /FOREIGN KEY constraint failed/);
  expectDbError(assert, () => db.prepare(`
    INSERT INTO queues (service_type_id, queue_date) VALUES (?, '2026-19-39')`).run(ids.snacks), /CHECK constraint failed/);
});

test('capacity counts only non-cancelled tokens', () => {
  const { db, ids } = createFixture();
  const q = openQueue(db, ids.meals);
  db.prepare('UPDATE queues SET max_tokens = 1 WHERE queue_id = ?').run(q);
  const t = insertToken(db, q, ids.alice, 1);
  expectDbError(assert, () => insertToken(db, q, ids.bob, 2), /daily capacity/);
  db.prepare("UPDATE queue_tokens SET status = 'cancelled' WHERE token_id = ?").run(t);
  insertToken(db, q, ids.bob, 2);
});

test('views compute live positions and estimates', () => {
  const { db, ids } = createFixture();
  const q = openQueue(db, ids.meals);
  insertToken(db, q, ids.alice, 1);
  insertToken(db, q, ids.bob, 2);
  const eta = db.prepare('SELECT position, est_wait_minutes FROM v_token_eta WHERE queue_id = ? ORDER BY position').all(q);
  assert.deepEqual(eta.map((e) => e.position), [1, 2]);
  // 1 open counter serves meals, configured 4 min each
  assert.deepEqual(eta.map((e) => e.est_wait_minutes), [4, 8]);
  const live = () => db.prepare('SELECT waiting_count, open_counters, est_wait_minutes FROM v_service_live_status WHERE service_type_id = ?').get(ids.meals);
  assert.deepEqual({ ...live() }, { waiting_count: 2, open_counters: 1, est_wait_minutes: 12 });
  // with no open counter there is no estimate at all
  db.prepare("UPDATE counters SET status = 'closed' WHERE counter_id = ?").run(ids.counterA);
  assert.equal(live().est_wait_minutes, null);
  assert.equal(db.prepare('SELECT est_wait_minutes AS e FROM v_token_eta WHERE queue_id = ? LIMIT 1').get(q).e, null);
});
