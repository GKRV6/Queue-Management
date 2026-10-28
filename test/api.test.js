'use strict';

// End-to-end HTTP tests against the real Express app and an in-memory database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, PASSWORD } = require('./fixtures');
const { createApp } = require('../src/app');

async function startServer() {
  const fx = createFixture();
  const server = createApp(fx.db, { loginMaxAttempts: 1000 }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...fx, base, close: () => new Promise((r) => server.close(r)) };
}

function client(base) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}, h) => call('POST', p, b, h),
    patch: (p, b = {}) => call('PATCH', p, b),
    del: (p) => call('DELETE', p, {}),
    login: (email) => call('POST', '/api/auth/login', { email, password: PASSWORD }),
  };
}

test('HTTP API', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  await t.test('rejects anonymous access and bad credentials', async () => {
    const c = client(s.base);
    assert.equal((await c.get('/api/centers')).status, 401);
    const bad = await c.post('/api/auth/login', { email: 'alice@test.edu', password: 'wrong' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.success, false);
    assert.equal((await c.post('/api/auth/login', { email: 'not-an-email' })).status, 400);
    assert.equal((await c.get('/api/nope')).status, 404);
  });

  await t.test('register, me and logout', async () => {
    const c = client(s.base);
    const reg = await c.post('/api/auth/register', { fullName: 'New Student', email: 'New@Test.edu', password: 'longenough' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.data.role, 'customer');
    assert.equal(reg.body.data.email, 'new@test.edu');
    assert.equal((await c.get('/api/auth/me')).body.data.full_name, 'New Student');
    const dup = await client(s.base).post('/api/auth/register', { fullName: 'Again', email: 'new@test.edu', password: 'longenough' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already exists/);
    assert.equal((await client(s.base).post('/api/auth/register', { fullName: 'Short', email: 'a@b.co', password: 'short' })).status, 400);
    await c.post('/api/auth/logout');
  });

  await t.test('a malformed cookie is ignored instead of failing the request', async () => {
    const res = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'qws_session=%E0%A4%A' },
      body: JSON.stringify({ email: 'alice@test.edu', password: PASSWORD }),
    });
    assert.equal(res.status, 200);
  });

  await t.test('passwords are not trimmed and string fields reject objects', async () => {
    const c = client(s.base);
    assert.equal((await c.post('/api/auth/register', { fullName: 'Space Pass', email: 'space@test.edu', password: '  spaced1  ' })).status, 201);
    assert.equal((await client(s.base).post('/api/auth/login', { email: 'space@test.edu', password: 'spaced1' })).status, 401);
    assert.equal((await client(s.base).post('/api/auth/login', { email: 'space@test.edu', password: '  spaced1  ' })).status, 200);
    assert.equal((await client(s.base).post('/api/auth/register', { fullName: { a: 1 }, email: 'obj@test.edu', password: 'longenough' })).status, 400);
  });

  await t.test('mutations must be JSON (CSRF guard) and bodies must parse', async () => {
    const c = client(s.base);
    await c.login('alice@test.edu');
    const form = await c.post('/api/tokens', 'serviceTypeId=1', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    const broken = await c.post('/api/tokens', '{bad json');
    assert.equal(broken.status, 400);
  });

  await t.test('customer → staff → customer full journey', async () => {
    const alice = client(s.base);
    const staff = client(s.base);
    await alice.login('alice@test.edu');
    await staff.login('staffa@test.edu');

    const centers = await alice.get('/api/centers');
    assert.equal(centers.body.data.length, 2);
    const detail = await alice.get(`/api/centers/${s.ids.canteen}`);
    assert.equal(detail.body.data.services.length, 2);

    const join = await alice.post('/api/tokens', { serviceTypeId: s.ids.meals, notes: 'extra rice' });
    assert.equal(join.status, 201);
    const tokenId = join.body.data.token_id;
    assert.equal((await alice.post('/api/tokens', { serviceTypeId: s.ids.meals })).status, 409);
    assert.equal((await alice.post('/api/tokens', { serviceTypeId: 'abc' })).status, 400);

    assert.equal((await alice.get('/api/tokens/active')).body.data[0].position, 1);
    assert.equal((await alice.get('/api/staff/dashboard')).status, 403);

    const called = await staff.post('/api/staff/call-next');
    assert.equal(called.body.data.token.token_id, tokenId);
    assert.equal((await staff.post(`/api/staff/tokens/${tokenId}/start`)).body.data.status, 'serving');
    const done = await staff.post(`/api/staff/tokens/${tokenId}/complete`, { remarks: 'paid' });
    assert.equal(done.body.data.status, 'completed');
    assert.equal((await staff.post('/api/staff/call-next')).body.data.token, null);

    const fb = await alice.post(`/api/tokens/${tokenId}/feedback`, { rating: 5, comment: 'Fast!' });
    assert.equal(fb.status, 201);
    assert.equal((await alice.post(`/api/tokens/${tokenId}/feedback`, { rating: 4 })).status, 409);
    assert.equal((await alice.post(`/api/tokens/${tokenId}/feedback`, { rating: 9 })).status, 400);
    const history = await alice.get('/api/tokens/history');
    assert.equal(history.body.data[0].rating, 5);
    const timeline = await alice.get(`/api/tokens/${tokenId}/timeline`);
    assert.equal(timeline.body.data.length, 4);

    const notes = await alice.get('/api/notifications');
    assert.ok(notes.body.data.unread > 0);
    await alice.post(`/api/notifications/${notes.body.data.items[0].notification_id}/read`);
    await alice.post('/api/notifications/read-all');
    assert.equal((await alice.get('/api/notifications')).body.data.unread, 0);
  });

  await t.test('staff counter, skip, requeue, queue status', async () => {
    const bob = client(s.base);
    const staff = client(s.base);
    await bob.login('bob@test.edu');
    await staff.login('staffa@test.edu');
    const { body } = await bob.post('/api/tokens', { serviceTypeId: s.ids.snacks });
    const id = body.data.token_id;
    await staff.post('/api/staff/call-next');
    assert.equal((await staff.post(`/api/staff/tokens/${id}/skip`)).body.data.status, 'skipped');
    assert.equal((await staff.post(`/api/staff/tokens/${id}/requeue`)).body.data.status, 'waiting');
    assert.equal((await staff.post(`/api/staff/tokens/${id}/prioritize`)).body.data.priority, 'priority');
    assert.equal((await staff.patch('/api/staff/counter', { status: 'sideways' })).status, 400);
    assert.equal((await staff.patch('/api/staff/counter', { status: 'paused' })).body.data.counter_status, 'paused');
    assert.equal((await staff.post('/api/staff/call-next')).status, 409);
    await staff.patch('/api/staff/counter', { status: 'open' });
    const closed = await staff.patch(`/api/staff/queues/${body.data.queue_id}`, { status: 'closed' });
    assert.equal(closed.body.data.status, 'closed');
    assert.equal((await bob.get('/api/tokens/active')).body.data.length, 0);
    assert.equal((await staff.post(`/api/staff/tokens/abc/skip`)).status, 400);
  });

  await t.test('admin endpoints', async () => {
    const admin = client(s.base);
    await admin.login('admin@test.edu');
    assert.equal((await client(s.base).get('/api/admin/overview')).status, 401);

    const overview = await admin.get('/api/admin/overview');
    assert.equal(overview.body.data.centers.length, 2);
    assert.equal(overview.body.data.active_centers, 2);
    const analytics = await admin.get(`/api/admin/analytics?days=7&centerId=${s.ids.canteen}`);
    assert.ok(Array.isArray(analytics.body.data.heatmap));
    assert.equal(analytics.body.data.ratings.length, 5);
    assert.equal((await admin.get('/api/admin/analytics?days=0')).status, 400);

    const center = await admin.post('/api/admin/centers', {
      name: 'Library Desk', category: 'library', location: 'Library', openingTime: '09:00', closingTime: '17:00',
    });
    assert.equal(center.status, 201);
    const cid = center.body.data.center_id;
    assert.equal((await admin.post('/api/admin/centers', { name: 'Bad', category: 'mall', location: 'X', openingTime: '9', closingTime: '17:00' })).status, 400);
    assert.equal((await admin.patch(`/api/admin/centers/${cid}`, { description: 'Book returns' })).body.data.description, 'Book returns');

    const svc = await admin.post('/api/admin/service-types', { centerId: cid, name: 'Book Return', code: 'br', avgServiceMinutes: 2 });
    assert.equal(svc.body.data.code, 'BR');
    assert.equal((await admin.patch(`/api/admin/service-types/${svc.body.data.service_type_id}`, { fee: 5 })).body.data.fee, 5);
    const counter = await admin.post('/api/admin/counters', { centerId: cid, counterNumber: 1, label: 'Desk 1', serviceTypeIds: [svc.body.data.service_type_id] });
    assert.equal(counter.status, 201);
    const cross = await admin.post('/api/admin/counters', { centerId: cid, counterNumber: 2, label: 'Desk 2', serviceTypeIds: [s.ids.meals] });
    assert.equal(cross.status, 409);
    assert.match(cross.body.error, /same service center/);
    assert.equal((await admin.patch(`/api/admin/counters/${counter.body.data.counter_id}`, { status: 'open', label: 'Desk One' })).body.data.label, 'Desk One');

    const slot = await admin.post('/api/admin/time-slots', { centerId: cid, startTime: '10:00', endTime: '11:00', maxTokens: 4 });
    assert.equal(slot.status, 201);
    assert.equal((await admin.post('/api/admin/time-slots', { centerId: cid, startTime: '12:00', endTime: '11:00', maxTokens: 4 })).status, 409);
    assert.equal((await admin.patch(`/api/admin/time-slots/${slot.body.data.slot_id}`, { maxTokens: 6 })).body.data.max_tokens, 6);
    assert.equal((await admin.del(`/api/admin/time-slots/${slot.body.data.slot_id}`)).status, 200);
    assert.equal((await admin.del(`/api/admin/time-slots/${slot.body.data.slot_id}`)).status, 404);

    const cfg = await admin.get(`/api/admin/centers/${cid}`);
    assert.equal(cfg.body.data.counters[0].service_ids.length, 1);

    const staff = await admin.post('/api/admin/staff', {
      fullName: 'Desk Clerk', email: 'clerk@test.edu', password: 'clerkpass1', centerId: cid,
      counterId: counter.body.data.counter_id, designation: 'Clerk',
    });
    assert.equal(staff.status, 201);
    assert.equal(staff.body.data.counter_label, 'Desk One');
    const moved = await admin.patch(`/api/admin/staff/${staff.body.data.staff_id}`, { centerId: s.ids.canteen });
    assert.equal(moved.body.data.counter_id, null);
    assert.equal((await admin.get('/api/admin/staff')).body.data.length, 3);

    const users = await admin.get('/api/admin/users?role=customer&search=ali');
    assert.equal(users.body.data.length, 1);
    assert.equal((await admin.patch(`/api/admin/users/${s.ids.admin}`, { isActive: false })).status, 409);
    assert.equal((await admin.patch(`/api/admin/users/${s.ids.carol}`, { isActive: false })).status, 200);
    assert.equal((await client(s.base).login('carol@test.edu')).status, 401);

    assert.ok(Array.isArray((await admin.get('/api/admin/queues')).body.data));
    assert.ok(Array.isArray((await admin.get('/api/admin/feedback?maxRating=5')).body.data));

    const reports = await admin.get('/api/admin/reports');
    assert.ok(reports.body.data.length >= 15);
    for (const r of reports.body.data) {
      const res = await admin.get(`/api/admin/reports/${r.name}`);
      assert.equal(res.status, 200, `report ${r.name}`);
      assert.ok(Array.isArray(res.body.data.columns));
    }
    assert.equal((await admin.get('/api/admin/reports/drop_tables')).status, 404);

    const schema = await admin.get('/api/admin/schema');
    const names = schema.body.data.tables.map((x) => x.name);
    for (const required of ['users', 'service_centers', 'counters', 'service_types', 'queues', 'queue_tokens', 'service_staff',
      'service_records', 'time_slots', 'queue_status_history', 'feedback', 'notifications']) {
      assert.ok(names.includes(required), `missing table ${required}`);
    }
    assert.ok(schema.body.data.triggers.length >= 10);
  });

  await t.test('serves the single-page app with security headers', async () => {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });
});

test('login is rate limited per client', async () => {
  const fx = createFixture();
  const server = createApp(fx.db, { loginMaxAttempts: 2 }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const c = client(`http://127.0.0.1:${server.address().port}`);
  try {
    await c.login('alice@test.edu');
    await c.login('alice@test.edu');
    assert.equal((await c.login('alice@test.edu')).status, 429);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
