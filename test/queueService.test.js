'use strict';

// Business transactions of the queue service.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures');
const q = require('../src/services/queueService');
const { getStaffDashboard } = require('../src/services/staffService');
const catalog = require('../src/services/catalogService');

const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

test('joinQueue creates the daily queue on demand and numbers tokens sequentially', () => {
  const { db, ids } = createFixture();
  const a = q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  const b = q.joinQueue(db, ids.bob, { serviceTypeId: ids.meals, notes: 'veg' });
  assert.equal(a.token_code, 'M-001');
  assert.equal(b.token_code, 'M-002');
  assert.equal(a.queue_id, b.queue_id);
  assert.equal(b.position, 2);
  assert.equal(b.notes, 'veg');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM queues'), 1);
});

test('joinQueue rejects unknown or inactive services and past slots', () => {
  const { db, ids } = createFixture();
  assert.throws(() => q.joinQueue(db, ids.alice, { serviceTypeId: 999 }), /Service not found/);
  db.prepare('UPDATE service_types SET is_active = 0 WHERE service_type_id = ?').run(ids.snacks);
  assert.throws(() => q.joinQueue(db, ids.alice, { serviceTypeId: ids.snacks }), /not available/);
  assert.throws(() => q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals, slotId: ids.clinicSlot }), /does not belong/);
  const past = Number(db.prepare(`INSERT INTO time_slots (center_id, start_time, end_time, max_tokens) VALUES (?, '00:00', '00:01', 5)`)
    .run(ids.canteen).lastInsertRowid);
  assert.throws(() => q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals, slotId: past }), /already ended/);
});

test('a failed join rolls back the whole transaction', () => {
  const { db, ids } = createFixture();
  q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  const before = count(db, 'SELECT COUNT(*) AS n FROM notifications');
  assert.throws(() => q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals }), /UNIQUE/);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM queue_tokens'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM notifications'), before);
  assert.equal(db.isTransaction, false);
});

test('a customer cannot exceed the daily token cap by joining and cancelling', () => {
  const { db, ids } = createFixture();
  for (let i = 0; i < q.MAX_TOKENS_PER_USER_PER_DAY; i += 1) {
    const t = q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
    q.cancelToken(db, ids.alice, t.token_id);
  }
  assert.throws(() => q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals }), /at most/);
  assert.equal(q.joinQueue(db, ids.bob, { serviceTypeId: ids.meals }).status, 'waiting');
});

test('day rollover closes stale queues and hides their tokens', () => {
  const { db, ids } = createFixture();
  const t = q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  // pretend the queue (and token) belong to yesterday
  db.prepare("UPDATE queues SET queue_date = date('now', 'localtime', '-1 day'), opened_at = datetime('now', 'localtime', '-1 day') WHERE queue_id = ?").run(t.queue_id);
  db.exec('DROP TRIGGER trg_tokens_immutable_identity');
  db.prepare("UPDATE queue_tokens SET issued_at = datetime('now', 'localtime', '-1 day') WHERE token_id = ?").run(t.token_id);
  assert.equal(q.getActiveTokens(db, ids.alice).length, 0);
  assert.equal(q.closeStaleQueues(db), 1);
  assert.equal(db.prepare('SELECT status FROM queue_tokens WHERE token_id = ?').get(t.token_id).status, 'cancelled');
  assert.equal(q.closeStaleQueues(db), 0);
  assert.equal(q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals }).token_code, 'M-001');
});

test('timeline visibility and requeue on a closed queue', () => {
  const { db, ids } = createFixture();
  const clinic = q.joinQueue(db, ids.alice, { serviceTypeId: ids.consult });
  assert.throws(() => q.getTokenTimeline(db, clinic.token_id, { user_id: ids.staffA, role: 'staff' }), /not found/);
  assert.ok(q.getTokenTimeline(db, clinic.token_id, { user_id: ids.admin, role: 'admin' }).length > 0);

  const t = q.joinQueue(db, ids.bob, { serviceTypeId: ids.meals });
  assert.ok(q.getTokenTimeline(db, t.token_id, { user_id: ids.staffA, role: 'staff' }).length > 0);
  q.callNext(db, ids.staffA);
  q.skipToken(db, ids.staffA, t.token_id);
  q.setQueueStatus(db, { user_id: ids.admin, role: 'admin' }, t.queue_id, 'paused');
  db.prepare("UPDATE queues SET status = 'closed', closed_at = datetime('now', 'localtime') WHERE queue_id = ?").run(t.queue_id);
  assert.throws(() => q.requeueToken(db, ids.staffA, t.token_id), /queue is closed/);
});

test('slot tokens wait until the slot starts and do not block others', () => {
  const { db, ids } = createFixture();
  const booked = q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals, slotId: ids.futureSlot });
  const now = q.joinQueue(db, ids.bob, { serviceTypeId: ids.meals });
  assert.equal(booked.is_eligible, 0);
  assert.equal(now.position, 1, 'eligible token goes first');
  const called = q.callNext(db, ids.staffA);
  assert.equal(called.token_id, now.token_id);
  assert.throws(() => q.joinQueue(db, ids.carol, { serviceTypeId: ids.snacks, slotId: ids.futureSlot }), /fully booked/);
});

test('callNext serves priority first, then first-come-first-served across the counter services', () => {
  const { db, ids } = createFixture();
  const t1 = q.joinQueue(db, ids.alice, { serviceTypeId: ids.snacks });
  const t2 = q.joinQueue(db, ids.bob, { serviceTypeId: ids.meals });
  const t3 = q.joinQueue(db, ids.carol, { serviceTypeId: ids.meals });
  q.prioritizeToken(db, ids.staffA, t3.token_id);

  const order = [];
  for (let i = 0; i < 3; i += 1) {
    const t = q.callNext(db, ids.staffA);
    order.push(t.token_id);
    q.startServing(db, ids.staffA, t.token_id);
    q.completeToken(db, ids.staffA, t.token_id, { remarks: 'ok' });
  }
  assert.deepEqual(order, [t3.token_id, t1.token_id, t2.token_id]);
  assert.equal(q.callNext(db, ids.staffA), null);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM service_records WHERE ended_at IS NOT NULL'), 3);
});

test('counter B only calls service types it handles', () => {
  const { db, ids } = createFixture();
  q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  assert.equal(q.callNext(db, ids.staffB), null);
  const s = q.joinQueue(db, ids.bob, { serviceTypeId: ids.snacks });
  assert.equal(q.callNext(db, ids.staffB).token_id, s.token_id);
});

test('staff must finish the current token before calling the next one', () => {
  const { db, ids } = createFixture();
  q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  q.joinQueue(db, ids.bob, { serviceTypeId: ids.meals });
  q.callNext(db, ids.staffA);
  assert.throws(() => q.callNext(db, ids.staffA), /Finish, skip or mark/);
  assert.throws(() => q.setCounterStatus(db, ids.staffA, 'paused'), /before pausing/);
});

test('a closed counter cannot call tokens', () => {
  const { db, ids } = createFixture();
  q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  const ctx = q.setCounterStatus(db, ids.staffA, 'closed');
  assert.equal(ctx.counter_status, 'closed');
  assert.equal(ctx.is_on_duty, 0);
  assert.throws(() => q.callNext(db, ids.staffA), /Open your counter/);
});

test('skip, re-queue and no-show flow', () => {
  const { db, ids } = createFixture();
  const t = q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  q.callNext(db, ids.staffA);
  assert.equal(q.skipToken(db, ids.staffA, t.token_id).status, 'skipped');
  const back = q.requeueToken(db, ids.staffA, t.token_id);
  assert.equal(back.status, 'waiting');
  assert.equal(back.counter_id, null);
  q.callNext(db, ids.staffA);
  assert.equal(q.markNoShow(db, ids.staffA, t.token_id).status, 'no_show');
  const types = db.prepare('SELECT type FROM notifications WHERE token_id = ? ORDER BY notification_id').all(t.token_id).map((r) => r.type);
  assert.deepEqual(types.filter((x) => x !== 'turn_near'), ['token_issued', 'called', 'skipped', 'requeued', 'called', 'no_show']);
});

test('staff actions are limited to their own center and counter', () => {
  const { db, ids } = createFixture();
  const snack = q.joinQueue(db, ids.alice, { serviceTypeId: ids.snacks });
  q.callNext(db, ids.staffB);
  assert.throws(() => q.startServing(db, ids.staffA, snack.token_id), /different counter/);
  assert.throws(() => q.completeToken(db, ids.staffB, snack.token_id), /expected serving/);
  assert.throws(() => q.getStaffContext(db, ids.alice), /No staff profile/);
});

test('customers can cancel only their own live tokens', () => {
  const { db, ids } = createFixture();
  const t = q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  assert.throws(() => q.cancelToken(db, ids.bob, t.token_id), /Token not found/);
  assert.equal(q.cancelToken(db, ids.alice, t.token_id).status, 'cancelled');
  assert.throws(() => q.cancelToken(db, ids.alice, t.token_id), /cannot be cancelled/);
});

test('turn-near alert is sent once when a customer reaches the front', () => {
  const { db, ids } = createFixture();
  const tokens = [ids.alice, ids.bob, ids.carol, ids.admin].map((u) => q.joinQueue(db, u, { serviceTypeId: ids.meals }));
  const alerts = () => db.prepare("SELECT token_id FROM notifications WHERE type = 'turn_near'").all().map((r) => r.token_id);
  assert.deepEqual(alerts(), tokens.slice(0, 3).map((t) => t.token_id));
  q.callNext(db, ids.staffA);
  assert.deepEqual(alerts().sort(), tokens.map((t) => t.token_id).sort());
});

test('closing a queue cancels waiting tokens atomically; staff cannot touch other centers', () => {
  const { db, ids } = createFixture();
  const a = q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  q.joinQueue(db, ids.bob, { serviceTypeId: ids.meals });
  const staffUser = { user_id: ids.staffA, role: 'staff' };
  const closed = q.setQueueStatus(db, staffUser, a.queue_id, 'closed');
  assert.equal(closed.status, 'closed');
  assert.ok(closed.closed_at);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM queue_tokens WHERE status = 'cancelled'"), 2);
  assert.throws(() => q.joinQueue(db, ids.carol, { serviceTypeId: ids.meals }), /not accepting/);
  const reopened = q.setQueueStatus(db, staffUser, a.queue_id, 'open');
  assert.equal(reopened.closed_at, null);

  const clinicToken = q.joinQueue(db, ids.alice, { serviceTypeId: ids.consult });
  assert.throws(() => q.setQueueStatus(db, staffUser, clinicToken.queue_id, 'paused'), /own service center/);
  assert.throws(() => q.setQueueStatus(db, staffUser, 999, 'paused'), /Queue not found/);
});

test('history, timeline and feedback for a served token', () => {
  const { db, ids } = createFixture();
  const t = q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  q.callNext(db, ids.staffA);
  q.startServing(db, ids.staffA, t.token_id);
  q.completeToken(db, ids.staffA, t.token_id);
  assert.equal(q.getActiveTokens(db, ids.alice).length, 0);
  const [h] = q.getTokenHistory(db, ids.alice);
  assert.equal(h.status, 'completed');
  assert.equal(h.rating, null);
  assert.deepEqual(q.getTokenTimeline(db, t.token_id, { user_id: ids.alice, role: 'customer' }).map((r) => r.to_status),
    ['waiting', 'called', 'serving', 'completed']);
  assert.throws(() => q.getTokenTimeline(db, t.token_id, { user_id: ids.bob, role: 'customer' }), /not found/);
  assert.throws(() => q.submitFeedback(db, ids.bob, t.token_id, { rating: 5 }), /not found/);
  assert.equal(q.submitFeedback(db, ids.alice, t.token_id, { rating: 5, comment: 'Great' }).rating, 5);
  assert.equal(q.getTokenHistory(db, ids.alice)[0].rating, 5);
});

test('staff dashboard and catalog reflect live state', () => {
  const { db, ids } = createFixture();
  q.joinQueue(db, ids.alice, { serviceTypeId: ids.meals });
  q.joinQueue(db, ids.bob, { serviceTypeId: ids.snacks });
  const current = q.callNext(db, ids.staffA);
  const dash = getStaffDashboard(db, ids.staffA);
  assert.equal(dash.current.token_id, current.token_id);
  assert.equal(dash.waiting.length, 1);
  assert.equal(dash.services.length, 2);

  const centers = catalog.listCenters(db);
  assert.equal(centers.find((c) => c.center_id === ids.canteen).waiting_count, 1);
  const detail = catalog.getCenter(db, ids.canteen);
  assert.equal(detail.counters.find((c) => c.counter_id === ids.counterA).current_token, current.token_code);
  assert.equal(detail.slots.length, 1);
  assert.throws(() => catalog.getCenter(db, 999), /not found/);

  const { items, unread } = catalog.listNotifications(db, ids.alice);
  assert.ok(unread >= 2);
  catalog.markNotificationRead(db, ids.alice, items[0].notification_id);
  assert.throws(() => catalog.markNotificationRead(db, ids.bob, items[0].notification_id), /not found/);
  catalog.markAllNotificationsRead(db, ids.alice);
  assert.equal(catalog.listNotifications(db, ids.alice).unread, 0);
});
