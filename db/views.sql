-- =====================================================================
--  Queue Without Standing - Views
--  Derived data is computed, never stored, so it can never go stale.
-- =====================================================================

-- Everything about a token in one row (used by every dashboard)
CREATE VIEW v_token_details AS
SELECT t.token_id,
       t.queue_id,
       t.user_id,
       u.full_name                                       AS customer_name,
       u.email                                           AS customer_email,
       t.token_number,
       st.code || '-' || printf('%03d', t.token_number)  AS token_code,
       t.status,
       t.priority,
       t.notes,
       t.issued_at,
       t.updated_at,
       q.queue_date,
       q.status                                          AS queue_status,
       st.service_type_id,
       st.name                                           AS service_name,
       sc.center_id,
       sc.name                                           AS center_name,
       sc.category,
       sc.location,
       t.counter_id,
       c.label                                           AS counter_label,
       t.slot_id,
       ts.start_time                                     AS slot_start,
       ts.end_time                                       AS slot_end
FROM queue_tokens t
JOIN queues q           ON q.queue_id = t.queue_id
JOIN service_types st   ON st.service_type_id = q.service_type_id
JOIN service_centers sc ON sc.center_id = st.center_id
JOIN users u            ON u.user_id = t.user_id
LEFT JOIN counters c    ON c.counter_id = t.counter_id
LEFT JOIN time_slots ts ON ts.slot_id = t.slot_id;

-- Waiting tokens with their live position. A token booked for a time slot
-- only becomes eligible to be called when its slot starts.
-- Ordering rule: eligible first, then priority, then eligibility time, then issue order (token_id).
CREATE VIEW v_waiting_tokens AS
SELECT w.*,
       ROW_NUMBER() OVER (
           PARTITION BY w.queue_id
           ORDER BY w.is_eligible DESC, (w.priority = 'priority') DESC, w.eligible_at, w.token_id
       ) AS position
FROM (
    SELECT t.token_id,
           t.queue_id,
           t.user_id,
           t.token_number,
           t.priority,
           t.issued_at,
           t.slot_id,
           q.queue_date,
           q.service_type_id,
           CASE WHEN ts.slot_id IS NOT NULL AND q.queue_date || ' ' || ts.start_time || ':00' > t.issued_at
                THEN q.queue_date || ' ' || ts.start_time || ':00'
                ELSE t.issued_at
           END AS eligible_at,
           CASE WHEN ts.slot_id IS NULL
                  OR q.queue_date || ' ' || ts.start_time || ':00' <= datetime('now', 'localtime')
                THEN 1 ELSE 0
           END AS is_eligible
    FROM queue_tokens t
    JOIN queues q           ON q.queue_id = t.queue_id
    LEFT JOIN time_slots ts ON ts.slot_id = t.slot_id
    WHERE t.status = 'waiting'
) AS w;

-- Average real service duration per service type over the last 30 days.
-- Each duration is clamped to [0.25x, 4x] the configured time so a mis-click
-- or a token completed the next morning cannot distort the estimate, and the
-- learned value is only trusted once there are at least 5 samples.
CREATE VIEW v_service_time_estimates AS
SELECT st.service_type_id,
       CASE WHEN COUNT(sr.record_id) >= 5
            THEN ROUND(AVG(MIN(MAX((julianday(sr.ended_at) - julianday(sr.started_at)) * 1440,
                                   0.25 * st.avg_service_minutes),
                               4 * st.avg_service_minutes)), 2)
            ELSE st.avg_service_minutes
       END                 AS est_service_minutes,
       COUNT(sr.record_id) AS sample_size
FROM service_types st
LEFT JOIN queues q           ON q.service_type_id = st.service_type_id
                            AND q.queue_date >= date('now', 'localtime', '-30 days')
LEFT JOIN queue_tokens t     ON t.queue_id = q.queue_id AND t.status = 'completed'
LEFT JOIN service_records sr ON sr.token_id = t.token_id AND sr.ended_at IS NOT NULL
GROUP BY st.service_type_id;

-- Live status of every service type for today.
-- With no open counter there is no honest estimate, so est_wait_minutes is NULL.
CREATE VIEW v_service_live_status AS
SELECT s.*,
       CASE WHEN s.open_counters > 0
            THEN CAST(ROUND((s.waiting_count + 1) * s.est_service_minutes / s.open_counters) AS INTEGER)
       END AS est_wait_minutes
FROM (
    SELECT st.service_type_id,
           st.center_id,
           st.name,
           st.code,
           st.is_active,
           st.fee,
           q.queue_id,
           COALESCE(q.status, 'not_started') AS queue_status,
           (SELECT COUNT(*) FROM queue_tokens t
             WHERE t.queue_id = q.queue_id AND t.status = 'waiting')               AS waiting_count,
           (SELECT COUNT(*) FROM queue_tokens t
             WHERE t.queue_id = q.queue_id AND t.status IN ('called', 'serving'))  AS in_service_count,
           (SELECT COUNT(*) FROM queue_tokens t
             WHERE t.queue_id = q.queue_id AND t.status = 'completed')             AS served_today,
           (SELECT COUNT(*) FROM counter_services cs
              JOIN counters c ON c.counter_id = cs.counter_id
             WHERE cs.service_type_id = st.service_type_id AND c.status = 'open')  AS open_counters,
           e.est_service_minutes
    FROM service_types st
    JOIN v_service_time_estimates e ON e.service_type_id = st.service_type_id
    LEFT JOIN queues q              ON q.service_type_id = st.service_type_id
                                   AND q.queue_date = date('now', 'localtime')
) AS s;

-- Estimated waiting time for each waiting token
CREATE VIEW v_token_eta AS
SELECT w.token_id,
       w.queue_id,
       w.position,
       w.eligible_at,
       w.is_eligible,
       s.open_counters,
       s.est_service_minutes,
       CASE WHEN s.open_counters > 0 THEN MAX(
           CAST(ROUND(w.position * s.est_service_minutes / s.open_counters) AS INTEGER),
           CAST((julianday(w.eligible_at) - julianday('now', 'localtime')) * 1440 AS INTEGER)
       ) END AS est_wait_minutes
FROM v_waiting_tokens w
JOIN v_service_live_status s ON s.queue_id = w.queue_id;

-- Timing facts per token (basis of all wait-time analytics).
-- Waiting time starts at the later of issue time and booked slot start.
CREATE VIEW v_token_timings AS
SELECT t.token_id,
       t.queue_id,
       t.user_id,
       t.status,
       t.issued_at,
       q.queue_date,
       q.service_type_id,
       st.center_id,
       h.called_at,
       sr.started_at,
       sr.ended_at,
       sr.staff_id,
       sr.counter_id,
       ROUND((julianday(h.called_at) - julianday(
                CASE WHEN ts.slot_id IS NOT NULL AND q.queue_date || ' ' || ts.start_time || ':00' > t.issued_at
                     THEN q.queue_date || ' ' || ts.start_time || ':00'
                     ELSE t.issued_at END)) * 1440, 1)                AS wait_minutes,
       ROUND((julianday(sr.ended_at) - julianday(sr.started_at)) * 1440, 1) AS service_minutes
FROM queue_tokens t
JOIN queues q           ON q.queue_id = t.queue_id
JOIN service_types st   ON st.service_type_id = q.service_type_id
LEFT JOIN time_slots ts ON ts.slot_id = t.slot_id
LEFT JOIN (
    SELECT token_id, MIN(changed_at) AS called_at
    FROM queue_status_history
    WHERE to_status = 'called'
    GROUP BY token_id
) h ON h.token_id = t.token_id
LEFT JOIN service_records sr ON sr.token_id = t.token_id;

-- One row per center for the public board
CREATE VIEW v_center_overview AS
SELECT sc.center_id,
       sc.name,
       sc.category,
       sc.location,
       sc.description,
       sc.opening_time,
       sc.closing_time,
       sc.is_active,
       CASE WHEN strftime('%H:%M', 'now', 'localtime') BETWEEN sc.opening_time AND sc.closing_time
            THEN 1 ELSE 0 END                                              AS is_open_now,
       COALESCE(SUM(ls.waiting_count), 0)                                  AS waiting_count,
       COALESCE(SUM(ls.served_today), 0)                                   AS served_today,
       (SELECT COUNT(*) FROM counters c
         WHERE c.center_id = sc.center_id AND c.status = 'open')           AS open_counters,
       (SELECT COUNT(*) FROM counters c WHERE c.center_id = sc.center_id)  AS total_counters,
       MIN(CASE WHEN ls.is_active = 1 THEN ls.est_wait_minutes END)        AS min_wait_minutes,
       (SELECT ROUND(AVG(f.rating), 2)
          FROM feedback f
          JOIN queue_tokens t   ON t.token_id = f.token_id
          JOIN queues q         ON q.queue_id = t.queue_id
          JOIN service_types s2 ON s2.service_type_id = q.service_type_id
         WHERE s2.center_id = sc.center_id
           AND f.submitted_at >= date('now', 'localtime', '-30 days'))     AS avg_rating
FROM service_centers sc
LEFT JOIN v_service_live_status ls ON ls.center_id = sc.center_id
GROUP BY sc.center_id;
