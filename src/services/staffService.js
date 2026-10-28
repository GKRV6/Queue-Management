'use strict';

const { getStaffContext, getTokenView } = require('./queueService');

/** Everything the staff console needs in one round trip. */
function getStaffDashboard(db, userId) {
  const ctx = getStaffContext(db, userId);

  const services = ctx.counter_id
    ? db.prepare(`
        SELECT st.service_type_id, st.name, st.code
        FROM counter_services cs
        JOIN service_types st ON st.service_type_id = cs.service_type_id
        WHERE cs.counter_id = ?
        ORDER BY st.name`).all(ctx.counter_id)
    : [];

  const current = ctx.counter_id
    ? db.prepare(`
        SELECT token_id FROM queue_tokens
        WHERE counter_id = ? AND status IN ('called', 'serving')`).get(ctx.counter_id)
    : null;

  // Waiting line for the service types handled at this counter, in call order
  const waiting = ctx.counter_id
    ? db.prepare(`
        SELECT d.token_id, d.token_code, d.customer_name, d.service_name, d.priority, d.issued_at,
               d.slot_start, d.slot_end, d.notes, w.position, w.is_eligible, w.eligible_at
        FROM v_waiting_tokens w
        JOIN v_token_details d   ON d.token_id = w.token_id
        JOIN counter_services cs ON cs.service_type_id = w.service_type_id AND cs.counter_id = ?
        WHERE w.queue_date = date('now', 'localtime')
        ORDER BY w.is_eligible DESC, (w.priority = 'priority') DESC, w.eligible_at, w.token_id
        LIMIT 100`).all(ctx.counter_id)
    : [];

  const skipped = db.prepare(`
    SELECT token_id, token_code, customer_name, service_name, updated_at, counter_label
    FROM v_token_details
    WHERE center_id = ? AND status = 'skipped' AND queue_date = date('now', 'localtime')
    ORDER BY updated_at DESC`).all(ctx.center_id);

  const queues = db.prepare(`
    SELECT ls.queue_id, ls.service_type_id, ls.name, ls.code, ls.queue_status,
           ls.waiting_count, ls.in_service_count, ls.served_today, ls.open_counters, ls.est_wait_minutes
    FROM v_service_live_status ls
    WHERE ls.center_id = ? AND ls.is_active = 1
    ORDER BY ls.name`).all(ctx.center_id);

  const stats = db.prepare(`
    SELECT COUNT(*) AS served_today,
           ROUND(AVG((julianday(sr.ended_at) - julianday(sr.started_at)) * 1440), 1) AS avg_service_minutes,
           ROUND(AVG(f.rating), 2) AS avg_rating_today
    FROM service_records sr
    LEFT JOIN feedback f ON f.token_id = sr.token_id
    WHERE sr.staff_id = ? AND sr.ended_at IS NOT NULL AND sr.started_at >= date('now', 'localtime')`).get(ctx.staff_id);

  const recent = db.prepare(`
    SELECT d.token_code, d.customer_name, d.service_name, sr.started_at, sr.ended_at, sr.remarks,
           ROUND((julianday(sr.ended_at) - julianday(sr.started_at)) * 1440, 1) AS service_minutes
    FROM service_records sr
    JOIN v_token_details d ON d.token_id = sr.token_id
    WHERE sr.staff_id = ? AND sr.ended_at IS NOT NULL AND sr.started_at >= date('now', 'localtime')
    ORDER BY sr.ended_at DESC
    LIMIT 15`).all(ctx.staff_id);

  return {
    staff: ctx,
    services,
    current: current ? getTokenView(db, current.token_id) : null,
    waiting,
    skipped,
    queues,
    stats,
    recent,
  };
}

module.exports = { getStaffDashboard };
