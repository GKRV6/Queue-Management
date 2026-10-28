'use strict';

// All analytics accept an optional center filter using the
// "($center IS NULL OR column = $center)" pattern so one statement serves both cases.

function params(centerId, days) {
  return { center: centerId ?? null, days: `-${days} days` };
}

function getOverview(db) {
  const today = db.prepare(`
    SELECT COUNT(*)                                                 AS issued_today,
           SUM(t.status = 'waiting')                                AS waiting_now,
           SUM(t.status IN ('called', 'serving'))                   AS at_counters,
           SUM(t.status = 'completed')                              AS served_today,
           SUM(t.status = 'no_show')                                AS no_show_today,
           SUM(t.status = 'cancelled')                              AS cancelled_today
    FROM queue_tokens t
    JOIN queues q ON q.queue_id = t.queue_id
    WHERE q.queue_date = date('now', 'localtime')`).get();

  const wait = db.prepare(`
    SELECT ROUND(AVG(wait_minutes), 1) AS avg_wait_today
    FROM v_token_timings
    WHERE queue_date = date('now', 'localtime') AND called_at IS NOT NULL`).get();

  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM users WHERE role = 'customer')                 AS customers,
           (SELECT COUNT(*) FROM service_staff)                                 AS staff,
           (SELECT COUNT(*) FROM service_centers WHERE is_active = 1)           AS active_centers,
           (SELECT COUNT(*) FROM counters WHERE status = 'open')                AS open_counters,
           (SELECT COUNT(*) FROM counters)                                      AS total_counters,
           (SELECT ROUND(AVG(rating), 2) FROM feedback
             WHERE submitted_at >= date('now', 'localtime', '-30 days'))         AS avg_rating_30d,
           (SELECT COUNT(*) FROM queue_tokens)                                  AS all_time_tokens`).get();

  const centers = db.prepare('SELECT * FROM v_center_overview ORDER BY waiting_count DESC, name').all();
  return { ...today, ...wait, ...totals, centers };
}

/** Tokens issued by weekday x hour - the peak-hour heatmap. */
function getPeakHeatmap(db, { centerId, days = 30 }) {
  return db.prepare(`
    SELECT CAST(strftime('%w', t.issued_at) AS INTEGER) AS dow,
           CAST(strftime('%H', t.issued_at) AS INTEGER) AS hour,
           COUNT(*)                                     AS tokens
    FROM queue_tokens t
    JOIN queues q         ON q.queue_id = t.queue_id
    JOIN service_types st ON st.service_type_id = q.service_type_id
    WHERE t.issued_at >= date('now', 'localtime', $days)
      AND ($center IS NULL OR st.center_id = $center)
    GROUP BY dow, hour
    ORDER BY dow, hour`).all(params(centerId, days));
}

// Hours with fewer called tokens than this show no average wait (too noisy).
const MIN_WAIT_SAMPLE = 5;

/**
 * Average tokens and waiting time for every hour of the day. Token counts are
 * divided by every day in the period that had any activity, so an hour that
 * is only busy on one day is not mistaken for a daily peak.
 */
function getHourlyProfile(db, { centerId, days = 30 }) {
  return db.prepare(`
    WITH scope AS (
        SELECT * FROM v_token_timings tt
        WHERE tt.queue_date >= date('now', 'localtime', $days)
          AND ($center IS NULL OR tt.center_id = $center)
    ), active_days AS (
        SELECT COUNT(DISTINCT queue_date) AS n FROM scope
    )
    SELECT CAST(strftime('%H', s.issued_at) AS INTEGER)                  AS hour,
           ROUND(COUNT(*) * 1.0 / (SELECT n FROM active_days), 1)        AS avg_tokens,
           CASE WHEN COUNT(s.called_at) >= $minSample
                THEN ROUND(AVG(s.wait_minutes), 1) END                   AS avg_wait_minutes
    FROM scope s
    GROUP BY hour
    ORDER BY hour`).all({ ...params(centerId, days), minSample: MIN_WAIT_SAMPLE });
}

function getDailyTrend(db, { centerId, days = 30 }) {
  return db.prepare(`
    SELECT tt.queue_date                       AS day,
           COUNT(*)                            AS tokens,
           SUM(tt.status = 'completed')        AS completed,
           SUM(tt.status = 'no_show')          AS no_show,
           ROUND(AVG(tt.wait_minutes), 1)      AS avg_wait_minutes
    FROM v_token_timings tt
    WHERE tt.queue_date >= date('now', 'localtime', $days)
      AND ($center IS NULL OR tt.center_id = $center)
    GROUP BY tt.queue_date
    ORDER BY tt.queue_date`).all(params(centerId, days));
}

function getServiceBreakdown(db, { centerId, days = 30 }) {
  return db.prepare(`
    SELECT sc.name                          AS center,
           st.name                          AS service,
           COUNT(*)                         AS tokens,
           SUM(tt.status = 'completed')     AS completed,
           ROUND(AVG(tt.wait_minutes), 1)   AS avg_wait_minutes,
           ROUND(AVG(tt.service_minutes), 1) AS avg_service_minutes,
           ROUND(AVG(f.rating), 2)          AS avg_rating
    FROM v_token_timings tt
    JOIN service_types st   ON st.service_type_id = tt.service_type_id
    JOIN service_centers sc ON sc.center_id = st.center_id
    LEFT JOIN feedback f    ON f.token_id = tt.token_id
    WHERE tt.queue_date >= date('now', 'localtime', $days)
      AND ($center IS NULL OR tt.center_id = $center)
    GROUP BY st.service_type_id
    ORDER BY tokens DESC`).all(params(centerId, days));
}

function getRatingDistribution(db, { centerId, days = 30 }) {
  return db.prepare(`
    WITH ratings(rating) AS (VALUES (1), (2), (3), (4), (5))
    SELECT r.rating, COUNT(x.feedback_id) AS count
    FROM ratings r
    LEFT JOIN (
        SELECT f.feedback_id, f.rating
        FROM feedback f
        JOIN queue_tokens t   ON t.token_id = f.token_id
        JOIN queues q         ON q.queue_id = t.queue_id
        JOIN service_types st ON st.service_type_id = q.service_type_id
        WHERE f.submitted_at >= date('now', 'localtime', $days)
          AND ($center IS NULL OR st.center_id = $center)
    ) x ON x.rating = r.rating
    GROUP BY r.rating
    ORDER BY r.rating DESC`).all(params(centerId, days));
}

function getStaffPerformance(db, { centerId, days = 30 }) {
  return db.prepare(`
    SELECT u.full_name                                                      AS staff,
           sc.name                                                          AS center,
           COALESCE(c.label, '-')                                           AS counter,
           COUNT(sr.record_id)                                              AS served,
           ROUND(AVG((julianday(sr.ended_at) - julianday(sr.started_at)) * 1440), 1) AS avg_service_minutes,
           ROUND(AVG(f.rating), 2)                                          AS avg_rating
    FROM service_staff ss
    JOIN users u                 ON u.user_id = ss.user_id
    JOIN service_centers sc      ON sc.center_id = ss.center_id
    LEFT JOIN counters c         ON c.counter_id = ss.counter_id
    LEFT JOIN service_records sr ON sr.staff_id = ss.staff_id
                                AND sr.ended_at IS NOT NULL
                                AND sr.started_at >= date('now', 'localtime', $days)
    LEFT JOIN feedback f         ON f.token_id = sr.token_id
    WHERE ($center IS NULL OR ss.center_id = $center)
    GROUP BY ss.staff_id
    ORDER BY served DESC`).all(params(centerId, days));
}

function getAnalytics(db, filters) {
  return {
    heatmap: getPeakHeatmap(db, filters),
    hourly: getHourlyProfile(db, filters),
    daily: getDailyTrend(db, filters),
    services: getServiceBreakdown(db, filters),
    ratings: getRatingDistribution(db, filters),
    staff: getStaffPerformance(db, filters),
  };
}

module.exports = {
  getOverview,
  getAnalytics,
  getPeakHeatmap,
  getHourlyProfile,
  getDailyTrend,
  getServiceBreakdown,
  getRatingDistribution,
  getStaffPerformance,
};
