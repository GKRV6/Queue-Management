'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, createSchema } = require('../src/db');
const { seedDatabase } = require('../src/seed/seed');
const admin = require('../src/services/adminService');
const analytics = require('../src/services/analyticsService');

test('seed generates consistent history through the real triggers', () => {
  const db = openDatabase(':memory:');
  createSchema(db);
  const summary = seedDatabase(db, { days: 4 });
  assert.ok(summary.users > 200);
  assert.ok(summary.tokens > 300);

  const one = (sql) => db.prepare(sql).get();
  // every token has at least its creation row in the audit trail
  assert.equal(one(`SELECT COUNT(*) AS n FROM queue_tokens t
                    WHERE NOT EXISTS (SELECT 1 FROM queue_status_history h WHERE h.token_id = t.token_id)`).n, 0);
  // every completed token has a closed service record
  assert.equal(one(`SELECT COUNT(*) AS n FROM queue_tokens t LEFT JOIN service_records r ON r.token_id = t.token_id
                    WHERE t.status = 'completed' AND r.ended_at IS NULL`).n, 0);
  // past queues are closed, today's are open
  assert.equal(one(`SELECT COUNT(*) AS n FROM queues WHERE queue_date < date('now', 'localtime') AND status <> 'closed'`).n, 0);
  // the demo customer has a live token to look at
  assert.ok(one(`SELECT COUNT(*) AS n FROM queue_tokens t JOIN users u ON u.user_id = t.user_id
                 WHERE u.email = 'student@qws.edu' AND t.status = 'waiting'`).n >= 1);
  // something is happening right now for the dashboards
  assert.ok(one(`SELECT COUNT(*) AS n FROM queue_tokens WHERE status = 'waiting'`).n > 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  for (const r of admin.listReports()) {
    assert.doesNotThrow(() => admin.runReport(db, r.name), r.name);
  }
  const a = analytics.getAnalytics(db, { days: 30 });
  assert.ok(a.heatmap.length > 0 && a.hourly.length > 0 && a.staff.length === 10);
  assert.ok(analytics.getOverview(db).issued_today >= 0);
});
