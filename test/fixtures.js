'use strict';

const { openDatabase, createSchema } = require('../src/db');
const { hashPassword } = require('../src/auth');

const PASSWORD = 'Password@1';
let cachedHash = null;
const passwordHash = () => (cachedHash ??= hashPassword(PASSWORD));

/**
 * A small, fully known campus:
 *   center 1 "Test Canteen" (00:00-23:59) with services Meals (M) and Snacks (S)
 *   counter A serves M+S, counter B serves S only; both open with staff
 *   center 2 "Test Clinic" with service Consultation (C) and counter C (no staff)
 *   one booking slot in center 1 that starts in the future, capacity 1
 */
function createFixture() {
  const db = openDatabase(':memory:');
  createSchema(db);
  const user = (name, email, role) =>
    Number(db.prepare('INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, email, passwordHash(), role).lastInsertRowid);

  const ids = {};
  ids.admin = user('Admin User', 'admin@test.edu', 'admin');
  ids.alice = user('Alice Customer', 'alice@test.edu', 'customer');
  ids.bob = user('Bob Customer', 'bob@test.edu', 'customer');
  ids.carol = user('Carol Customer', 'carol@test.edu', 'customer');
  ids.staffA = user('Staff A', 'staffa@test.edu', 'staff');
  ids.staffB = user('Staff B', 'staffb@test.edu', 'staff');

  const center = (name, category) => Number(db.prepare(`
    INSERT INTO service_centers (name, category, location, opening_time, closing_time) VALUES (?, ?, 'Block T', '00:00', '23:59')`)
    .run(name, category).lastInsertRowid);
  ids.canteen = center('Test Canteen', 'canteen');
  ids.clinic = center('Test Clinic', 'clinic');

  const service = (centerId, name, code, avg) => Number(db.prepare(`
    INSERT INTO service_types (center_id, name, code, avg_service_minutes) VALUES (?, ?, ?, ?)`)
    .run(centerId, name, code, avg).lastInsertRowid);
  ids.meals = service(ids.canteen, 'Meals', 'M', 4);
  ids.snacks = service(ids.canteen, 'Snacks', 'S', 2);
  ids.consult = service(ids.clinic, 'Consultation', 'C', 10);

  const counter = (centerId, number, label, services) => {
    const id = Number(db.prepare(`
      INSERT INTO counters (center_id, counter_number, label, status) VALUES (?, ?, ?, 'open')`)
      .run(centerId, number, label).lastInsertRowid);
    for (const s of services) db.prepare('INSERT INTO counter_services VALUES (?, ?)').run(id, s);
    return id;
  };
  ids.counterA = counter(ids.canteen, 1, 'Counter A', [ids.meals, ids.snacks]);
  ids.counterB = counter(ids.canteen, 2, 'Counter B', [ids.snacks]);
  ids.counterC = counter(ids.clinic, 1, 'Counter C', [ids.consult]);

  const staff = (userId, centerId, counterId) => Number(db.prepare(`
    INSERT INTO service_staff (user_id, center_id, counter_id, designation) VALUES (?, ?, ?, 'Tester')`)
    .run(userId, centerId, counterId).lastInsertRowid);
  ids.staffARow = staff(ids.staffA, ids.canteen, ids.counterA);
  ids.staffBRow = staff(ids.staffB, ids.canteen, ids.counterB);

  // a slot that has not started yet (wraps safely around midnight by using 23:58-23:59)
  ids.futureSlot = Number(db.prepare(`
    INSERT INTO time_slots (center_id, start_time, end_time, max_tokens) VALUES (?, '23:58', '23:59', 1)`)
    .run(ids.canteen).lastInsertRowid);
  ids.clinicSlot = Number(db.prepare(`
    INSERT INTO time_slots (center_id, start_time, end_time, max_tokens) VALUES (?, '23:58', '23:59', 5)`)
    .run(ids.clinic).lastInsertRowid);

  return { db, ids, PASSWORD };
}

/** Expects fn to throw an error whose message matches pattern. */
function expectDbError(assert, fn, pattern) {
  assert.throws(fn, (err) => pattern.test(err.message), `expected error matching ${pattern}`);
}

module.exports = { createFixture, expectDbError, PASSWORD };
