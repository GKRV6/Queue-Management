'use strict';

const { transaction, loadReportQueries } = require('../db');
const { hashPassword } = require('../auth');
const { badRequest, notFound, conflict } = require('../errors');

/**
 * Builds "UPDATE table SET a = ?, b = ? WHERE key = ?" from a whitelist of
 * columns. Only keys present in `columns` are ever interpolated.
 */
function updateRow(db, table, keyColumn, id, fields, columns) {
  const entries = Object.entries(fields).filter(([k]) => columns[k]);
  if (!entries.length) throw badRequest('Nothing to update');
  const sets = entries.map(([k]) => `${columns[k]} = ?`).join(', ');
  const { changes } = db
    .prepare(`UPDATE ${table} SET ${sets} WHERE ${keyColumn} = ?`)
    .run(...entries.map(([, v]) => v), id);
  if (!changes) throw notFound('Record not found');
}

// ---------------------------------------------------------------- centers
const CENTER_COLUMNS = {
  name: 'name', category: 'category', location: 'location', description: 'description',
  openingTime: 'opening_time', closingTime: 'closing_time', isActive: 'is_active',
};

function createCenter(db, c) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO service_centers (name, category, location, description, opening_time, closing_time)
    VALUES (?, ?, ?, ?, ?, ?)`).run(c.name, c.category, c.location, c.description ?? null, c.openingTime, c.closingTime);
  return db.prepare('SELECT * FROM service_centers WHERE center_id = ?').get(lastInsertRowid);
}

function updateCenter(db, id, fields) {
  updateRow(db, 'service_centers', 'center_id', id, fields, CENTER_COLUMNS);
  return db.prepare('SELECT * FROM service_centers WHERE center_id = ?').get(id);
}

/** Full configuration of one center for the admin editor. */
function getCenterConfig(db, centerId) {
  const center = db.prepare('SELECT * FROM service_centers WHERE center_id = ?').get(centerId);
  if (!center) throw notFound('Service center not found');
  const services = db.prepare(`
    SELECT st.*, e.est_service_minutes, e.sample_size
    FROM service_types st
    JOIN v_service_time_estimates e ON e.service_type_id = st.service_type_id
    WHERE st.center_id = ? ORDER BY st.name`).all(centerId);
  const counters = db.prepare(`
    SELECT c.*, u.full_name AS staff_name, ss.staff_id,
           (SELECT json_group_array(cs.service_type_id) FROM counter_services cs WHERE cs.counter_id = c.counter_id) AS service_ids
    FROM counters c
    LEFT JOIN service_staff ss ON ss.counter_id = c.counter_id
    LEFT JOIN users u          ON u.user_id = ss.user_id
    WHERE c.center_id = ? ORDER BY c.counter_number`).all(centerId)
    .map((row) => ({ ...row, service_ids: JSON.parse(row.service_ids) }));
  const slots = db.prepare(`
    SELECT ts.*, (SELECT COUNT(*) FROM queue_tokens t WHERE t.slot_id = ts.slot_id) AS total_bookings
    FROM time_slots ts WHERE ts.center_id = ? ORDER BY ts.start_time`).all(centerId);
  return { center, services, counters, slots };
}

// ---------------------------------------------------------- service types
const SERVICE_COLUMNS = {
  name: 'name', code: 'code', description: 'description',
  avgServiceMinutes: 'avg_service_minutes', fee: 'fee', isActive: 'is_active',
};

function createServiceType(db, s) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO service_types (center_id, name, code, description, avg_service_minutes, fee)
    VALUES (?, ?, ?, ?, ?, ?)`).run(s.centerId, s.name, s.code, s.description ?? null, s.avgServiceMinutes, s.fee ?? 0);
  return db.prepare('SELECT * FROM service_types WHERE service_type_id = ?').get(lastInsertRowid);
}

function updateServiceType(db, id, fields) {
  updateRow(db, 'service_types', 'service_type_id', id, fields, SERVICE_COLUMNS);
  return db.prepare('SELECT * FROM service_types WHERE service_type_id = ?').get(id);
}

// --------------------------------------------------------------- counters
function setCounterServices(db, counterId, serviceTypeIds) {
  db.prepare('DELETE FROM counter_services WHERE counter_id = ?').run(counterId);
  const insert = db.prepare('INSERT INTO counter_services (counter_id, service_type_id) VALUES (?, ?)');
  for (const id of new Set(serviceTypeIds)) insert.run(counterId, id);
}

function createCounter(db, c) {
  return transaction(db, () => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO counters (center_id, counter_number, label) VALUES (?, ?, ?)`)
      .run(c.centerId, c.counterNumber, c.label);
    setCounterServices(db, Number(lastInsertRowid), c.serviceTypeIds || []);
    return db.prepare('SELECT * FROM counters WHERE counter_id = ?').get(lastInsertRowid);
  });
}

function updateCounter(db, id, { label, status, serviceTypeIds }) {
  return transaction(db, () => {
    const counter = db.prepare('SELECT * FROM counters WHERE counter_id = ?').get(id);
    if (!counter) throw notFound('Counter not found');
    if (status && status !== 'open') {
      const busy = db.prepare(`
        SELECT 1 FROM queue_tokens WHERE counter_id = ? AND status IN ('called', 'serving')`).get(id);
      if (busy) throw conflict('This counter is handling a token right now');
    }
    if (label !== undefined) db.prepare('UPDATE counters SET label = ? WHERE counter_id = ?').run(label, id);
    if (status !== undefined) db.prepare('UPDATE counters SET status = ? WHERE counter_id = ?').run(status, id);
    if (serviceTypeIds !== undefined) setCounterServices(db, id, serviceTypeIds);
    return db.prepare('SELECT * FROM counters WHERE counter_id = ?').get(id);
  });
}

// ------------------------------------------------------------- time slots
function createTimeSlot(db, s) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO time_slots (center_id, start_time, end_time, max_tokens) VALUES (?, ?, ?, ?)`)
    .run(s.centerId, s.startTime, s.endTime, s.maxTokens);
  return db.prepare('SELECT * FROM time_slots WHERE slot_id = ?').get(lastInsertRowid);
}

function updateTimeSlot(db, id, { maxTokens }) {
  const { changes } = db.prepare('UPDATE time_slots SET max_tokens = ? WHERE slot_id = ?').run(maxTokens, id);
  if (!changes) throw notFound('Time slot not found');
  return db.prepare('SELECT * FROM time_slots WHERE slot_id = ?').get(id);
}

function deleteTimeSlot(db, id) {
  // Deleting a slot would turn live bookings into immediate walk-ins (slot_id SET NULL)
  const booked = db.prepare(`
    SELECT COUNT(*) AS n FROM queue_tokens
    WHERE slot_id = ? AND status IN ('waiting', 'called', 'serving', 'skipped')`).get(id).n;
  if (booked) throw conflict(`${booked} live booking(s) use this slot; reduce its capacity instead or try again later`);
  const { changes } = db.prepare('DELETE FROM time_slots WHERE slot_id = ?').run(id);
  if (!changes) throw notFound('Time slot not found');
}

// ------------------------------------------------------------------ staff
function listStaff(db) {
  return db.prepare(`
    SELECT ss.staff_id, ss.user_id, u.full_name, u.email, u.phone, u.is_active,
           ss.center_id, sc.name AS center_name, ss.counter_id, c.label AS counter_label,
           ss.designation, ss.joined_on,
           (ss.counter_id IS NOT NULL AND c.status <> 'closed') AS is_on_duty,
           (SELECT COUNT(*) FROM service_records sr WHERE sr.staff_id = ss.staff_id) AS total_served
    FROM service_staff ss
    JOIN users u            ON u.user_id = ss.user_id
    JOIN service_centers sc ON sc.center_id = ss.center_id
    LEFT JOIN counters c    ON c.counter_id = ss.counter_id
    ORDER BY sc.name, u.full_name`).all();
}

/** Creates the USER row and its SERVICE_STAFF specialisation atomically. */
function createStaff(db, s) {
  return transaction(db, () => {
    const { lastInsertRowid: userId } = db.prepare(`
      INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'staff')`)
      .run(s.fullName, s.email, s.phone ?? null, hashPassword(s.password));
    db.prepare(`
      INSERT INTO service_staff (user_id, center_id, counter_id, designation) VALUES (?, ?, ?, ?)`)
      .run(userId, s.centerId, s.counterId ?? null, s.designation);
    return listStaff(db).find((row) => row.user_id === Number(userId));
  });
}

function updateStaff(db, staffId, { centerId, counterId, designation }) {
  return transaction(db, () => {
    const staff = db.prepare('SELECT * FROM service_staff WHERE staff_id = ?').get(staffId);
    if (!staff) throw notFound('Staff member not found');
    const nextCenter = centerId ?? staff.center_id;
    // moving to another center drops the old counter assignment
    let nextCounter = counterId !== undefined ? counterId : staff.counter_id;
    if (centerId !== undefined && centerId !== staff.center_id && counterId === undefined) nextCounter = null;
    if (staff.counter_id && staff.counter_id !== nextCounter) {
      const busy = db.prepare(`
        SELECT 1 FROM queue_tokens WHERE counter_id = ? AND status IN ('called', 'serving')`).get(staff.counter_id);
      if (busy) throw conflict('This staff member is serving a token right now');
    }
    db.prepare(`
      UPDATE service_staff SET center_id = ?, counter_id = ?, designation = ? WHERE staff_id = ?`)
      .run(nextCenter, nextCounter, designation ?? staff.designation, staffId);
    return listStaff(db).find((row) => row.staff_id === staffId);
  });
}

// ------------------------------------------------------------------ users
function listUsers(db, { role, search }) {
  return db.prepare(`
    SELECT u.user_id, u.full_name, u.email, u.phone, u.role, u.is_active, u.created_at,
           COUNT(t.token_id) AS tokens,
           MAX(t.issued_at)  AS last_visit
    FROM users u
    LEFT JOIN queue_tokens t ON t.user_id = u.user_id
    WHERE ($role IS NULL OR u.role = $role)
      AND ($search IS NULL OR u.full_name LIKE '%' || $search || '%' OR u.email LIKE '%' || $search || '%')
    GROUP BY u.user_id
    ORDER BY u.created_at DESC
    LIMIT 200`).all({ role: role ?? null, search: search ?? null });
}

function setUserActive(db, actorId, userId, isActive) {
  if (actorId === userId && !isActive) throw conflict('You cannot deactivate your own account');
  const { changes } = db.prepare('UPDATE users SET is_active = ? WHERE user_id = ?').run(isActive, userId);
  if (!changes) throw notFound('User not found');
}

// ----------------------------------------------------------------- queues
function listQueues(db, date) {
  return db.prepare(`
    SELECT q.queue_id, q.queue_date, q.status, q.max_tokens, q.opened_at, q.closed_at,
           st.name AS service_name, st.code, sc.name AS center_name, sc.center_id,
           COUNT(t.token_id)                         AS issued,
           SUM(t.status = 'waiting')                 AS waiting,
           SUM(t.status IN ('called', 'serving'))    AS at_counter,
           SUM(t.status = 'completed')               AS completed,
           SUM(t.status IN ('cancelled', 'no_show')) AS dropped
    FROM queues q
    JOIN service_types st   ON st.service_type_id = q.service_type_id
    JOIN service_centers sc ON sc.center_id = st.center_id
    LEFT JOIN queue_tokens t ON t.queue_id = q.queue_id
    WHERE q.queue_date = COALESCE(?, date('now', 'localtime'))
    GROUP BY q.queue_id
    ORDER BY sc.name, st.name`).all(date ?? null);
}

function listFeedback(db, { centerId, maxRating }) {
  return db.prepare(`
    SELECT f.feedback_id, f.rating, f.comment, f.submitted_at,
           d.token_code, d.customer_name, d.center_name, d.service_name,
           u.full_name AS served_by
    FROM feedback f
    JOIN v_token_details d       ON d.token_id = f.token_id
    LEFT JOIN service_records sr ON sr.token_id = f.token_id
    LEFT JOIN service_staff ss   ON ss.staff_id = sr.staff_id
    LEFT JOIN users u            ON u.user_id = ss.user_id
    WHERE ($center IS NULL OR d.center_id = $center)
      AND ($maxRating IS NULL OR f.rating <= $maxRating)
    ORDER BY f.submitted_at DESC
    LIMIT 100`).all({ center: centerId ?? null, maxRating: maxRating ?? null });
}

// ---------------------------------------------------------------- reports
let reportCache = null;
function getReports() {
  if (!reportCache) reportCache = loadReportQueries();
  return reportCache;
}

function listReports() {
  return getReports().map(({ name, title, concepts, description }) => ({ name, title, concepts, description }));
}

/** Runs one of the predefined, read-only report queries from db/queries.sql. */
function runReport(db, name) {
  const report = getReports().find((r) => r.name === name);
  if (!report) throw notFound('Report not found');
  const stmt = db.prepare(report.sql);
  const started = process.hrtime.bigint();
  const rows = stmt.all();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const columns = rows.length ? Object.keys(rows[0]) : stmt.columns().map((c) => c.name);
  return { ...report, columns, rows, elapsedMs: Math.round(ms * 100) / 100 };
}

// --------------------------------------------------------- schema explorer
function getSchemaInfo(db) {
  const objects = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END, name`).all();

  // Table names come from sqlite_master itself, never from user input.
  const tables = objects.filter((o) => o.type === 'table').map((t) => ({
    name: t.name,
    sql: t.sql,
    rows: db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n,
    columns: db.prepare('SELECT name, type, "notnull" AS not_null, dflt_value, pk FROM pragma_table_info(?)').all(t.name),
    foreignKeys: db.prepare('SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)').all(t.name),
  }));
  const pick = (type) => objects.filter((o) => o.type === type).map(({ name, tbl_name, sql }) => ({ name, table: tbl_name, sql }));
  return { tables, views: pick('view'), triggers: pick('trigger'), indexes: pick('index') };
}

module.exports = {
  createCenter,
  updateCenter,
  getCenterConfig,
  createServiceType,
  updateServiceType,
  createCounter,
  updateCounter,
  createTimeSlot,
  updateTimeSlot,
  deleteTimeSlot,
  listStaff,
  createStaff,
  updateStaff,
  listUsers,
  setUserActive,
  listQueues,
  listFeedback,
  listReports,
  runReport,
  getSchemaInfo,
};
