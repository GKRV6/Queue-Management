-- =====================================================================
--  Queue Without Standing - Report queries
--  Each block below is loaded by the server and shown in the
--  Admin > SQL Reports screen together with its live result.
--  Format:  -- name: <id>  /  -- title: <text>  /  -- concepts: <text>
--           -- description: <text>   followed by one SELECT statement.
-- =====================================================================

-- name: live_queue_board
-- title: Live queue board
-- concepts: JOIN, view composition, ORDER BY
-- description: Every service type's queue right now with waiting count, open counters and the estimated wait for a new arrival.
SELECT sc.name              AS center,
       ls.name              AS service,
       ls.queue_status,
       ls.waiting_count     AS waiting,
       ls.in_service_count  AS at_counter,
       ls.served_today,
       ls.open_counters,
       ls.est_service_minutes AS avg_service_min,
       ls.est_wait_minutes  AS new_arrival_wait_min
FROM v_service_live_status ls
JOIN service_centers sc ON sc.center_id = ls.center_id
WHERE ls.is_active = 1
ORDER BY ls.waiting_count DESC, sc.name;

-- name: peak_hours
-- title: Peak hours by center (last 30 days)
-- concepts: GROUP BY, strftime, conditional aggregation
-- description: Number of tokens issued in each hour of the day per center, averaged over every day the center was active.
WITH center_days AS (
    SELECT st.center_id, COUNT(DISTINCT q.queue_date) AS days
    FROM queues q
    JOIN service_types st ON st.service_type_id = q.service_type_id
    WHERE q.queue_date >= date('now', 'localtime', '-30 days')
    GROUP BY st.center_id
)
SELECT sc.name                                   AS center,
       strftime('%H', t.issued_at) || ':00'      AS hour,
       COUNT(*)                                  AS tokens,
       ROUND(COUNT(*) * 1.0 / cd.days, 1)        AS avg_tokens_per_day
FROM queue_tokens t
JOIN queues q           ON q.queue_id = t.queue_id
JOIN service_types st   ON st.service_type_id = q.service_type_id
JOIN service_centers sc ON sc.center_id = st.center_id
JOIN center_days cd     ON cd.center_id = st.center_id
WHERE q.queue_date >= date('now', 'localtime', '-30 days')
GROUP BY sc.center_id, hour
ORDER BY sc.name, hour;

-- name: busiest_hour_per_center
-- title: Single busiest hour of each center
-- concepts: CTE, window function RANK()
-- description: Uses RANK() over the hourly counts to pick the top hour for each center.
WITH hourly AS (
    SELECT st.center_id,
           strftime('%H', t.issued_at) AS hour,
           COUNT(*)                    AS tokens
    FROM queue_tokens t
    JOIN queues q         ON q.queue_id = t.queue_id
    JOIN service_types st ON st.service_type_id = q.service_type_id
    WHERE t.issued_at >= date('now', 'localtime', '-30 days')
    GROUP BY st.center_id, hour
), ranked AS (
    SELECT h.*, RANK() OVER (PARTITION BY center_id ORDER BY tokens DESC) AS rnk
    FROM hourly h
)
SELECT sc.name AS center, r.hour || ':00 - ' || printf('%02d', r.hour + 1) || ':00' AS busiest_slot, r.tokens
FROM ranked r
JOIN service_centers sc ON sc.center_id = r.center_id
WHERE r.rnk = 1
ORDER BY r.tokens DESC;

-- name: wait_time_by_service
-- title: Waiting and service time per service type (last 30 days)
-- concepts: view, AVG/MAX aggregates, HAVING
-- description: Average and worst waiting times and average service duration for every service type with enough data.
SELECT sc.name                       AS center,
       st.name                       AS service,
       COUNT(*)                      AS served,
       ROUND(AVG(tt.wait_minutes), 1)    AS avg_wait_min,
       MAX(tt.wait_minutes)              AS max_wait_min,
       ROUND(AVG(tt.service_minutes), 1) AS avg_service_min,
       st.avg_service_minutes            AS configured_service_min
FROM v_token_timings tt
JOIN service_types st   ON st.service_type_id = tt.service_type_id
JOIN service_centers sc ON sc.center_id = st.center_id
WHERE tt.status = 'completed'
  AND tt.queue_date >= date('now', 'localtime', '-30 days')
GROUP BY st.service_type_id
HAVING COUNT(*) >= 5
ORDER BY avg_wait_min DESC;

-- name: staff_performance
-- title: Staff performance leaderboard (last 30 days)
-- concepts: multi-table JOIN, LEFT JOIN, window function DENSE_RANK()
-- description: Tokens served, average service time and average customer rating for each staff member.
SELECT DENSE_RANK() OVER (ORDER BY COUNT(sr.record_id) DESC) AS rank,
       u.full_name                                    AS staff,
       sc.name                                        AS center,
       COUNT(sr.record_id)                            AS tokens_served,
       ROUND(AVG((julianday(sr.ended_at) - julianday(sr.started_at)) * 1440), 1) AS avg_service_min,
       ROUND(AVG(f.rating), 2)                        AS avg_rating,
       COUNT(f.feedback_id)                           AS ratings
FROM service_staff ss
JOIN users u                 ON u.user_id = ss.user_id
JOIN service_centers sc      ON sc.center_id = ss.center_id
LEFT JOIN service_records sr ON sr.staff_id = ss.staff_id
                            AND sr.ended_at IS NOT NULL
                            AND sr.started_at >= date('now', 'localtime', '-30 days')
LEFT JOIN feedback f         ON f.token_id = sr.token_id
GROUP BY ss.staff_id
ORDER BY tokens_served DESC;

-- name: center_satisfaction
-- title: Customer satisfaction per center
-- concepts: conditional aggregation with CASE, percentages
-- description: Average rating, rating distribution and share of happy (4-5 star) customers per center.
SELECT sc.name                                                    AS center,
       COUNT(f.feedback_id)                                       AS reviews,
       ROUND(AVG(f.rating), 2)                                    AS avg_rating,
       SUM(CASE WHEN f.rating = 5 THEN 1 ELSE 0 END)              AS five_star,
       SUM(CASE WHEN f.rating <= 2 THEN 1 ELSE 0 END)             AS one_two_star,
       ROUND(100.0 * SUM(CASE WHEN f.rating >= 4 THEN 1 ELSE 0 END) / COUNT(f.feedback_id), 1) AS happy_pct
FROM service_centers sc
JOIN service_types st ON st.center_id = sc.center_id
JOIN queues q         ON q.service_type_id = st.service_type_id
JOIN queue_tokens t   ON t.queue_id = q.queue_id
JOIN feedback f       ON f.token_id = t.token_id
GROUP BY sc.center_id
ORDER BY avg_rating DESC;

-- name: wait_vs_rating
-- title: Does waiting longer lower the rating?
-- concepts: CASE bucketing, JOIN with view, GROUP BY expression
-- description: Groups completed tokens into waiting-time buckets and compares the average rating of each bucket.
SELECT CASE
           WHEN tt.wait_minutes < 5  THEN '1. under 5 min'
           WHEN tt.wait_minutes < 10 THEN '2. 5-10 min'
           WHEN tt.wait_minutes < 20 THEN '3. 10-20 min'
           ELSE '4. 20+ min'
       END                     AS wait_bucket,
       COUNT(*)                AS rated_tokens,
       ROUND(AVG(f.rating), 2) AS avg_rating
FROM v_token_timings tt
JOIN feedback f ON f.token_id = tt.token_id
GROUP BY wait_bucket
ORDER BY wait_bucket;

-- name: outcome_funnel
-- title: Token outcome funnel per service type
-- concepts: pivot with SUM(CASE), ratio calculation, NULLIF
-- description: How many tokens ended completed, cancelled or as no-shows, and the no-show rate.
SELECT st.name                                                  AS service,
       COUNT(*)                                                 AS total,
       SUM(t.status = 'completed')                              AS completed,
       SUM(t.status = 'cancelled')                              AS cancelled,
       SUM(t.status = 'no_show')                                AS no_show,
       SUM(t.status IN ('waiting', 'called', 'serving', 'skipped')) AS still_open,
       ROUND(100.0 * SUM(t.status = 'no_show') / NULLIF(COUNT(*), 0), 1) AS no_show_pct
FROM queue_tokens t
JOIN queues q         ON q.queue_id = t.queue_id
JOIN service_types st ON st.service_type_id = q.service_type_id
GROUP BY st.service_type_id
ORDER BY no_show_pct DESC;

-- name: daily_trend
-- title: Daily volume and average wait (last 14 days)
-- concepts: GROUP BY date, LAG() window function for day-over-day change
-- description: Tokens per day across all centers with the change compared to the previous day.
WITH daily AS (
    SELECT tt.queue_date              AS day,
           COUNT(*)                   AS tokens,
           ROUND(AVG(tt.wait_minutes), 1) AS avg_wait_min
    FROM v_token_timings tt
    WHERE tt.queue_date >= date('now', 'localtime', '-14 days')
    GROUP BY tt.queue_date
)
SELECT day,
       CASE CAST(strftime('%w', day) AS INTEGER)
           WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed'
           WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' ELSE 'Sat' END AS weekday,
       tokens,
       tokens - LAG(tokens) OVER (ORDER BY day) AS change_vs_prev_day,
       avg_wait_min
FROM daily
ORDER BY day DESC;

-- name: time_slot_utilisation
-- title: Time-slot booking utilisation (last 14 days)
-- concepts: LEFT JOIN to keep empty slots, capacity ratio
-- description: How full each booking slot gets on average compared to its capacity.
SELECT sc.name                                        AS center,
       ts.start_time || ' - ' || ts.end_time          AS slot,
       ts.max_tokens                                  AS capacity,
       COUNT(t.token_id)                              AS bookings,
       COUNT(DISTINCT q.queue_date)                   AS days_used,
       ROUND(100.0 * COUNT(t.token_id) / (ts.max_tokens * 14), 1) AS avg_fill_pct
FROM time_slots ts
JOIN service_centers sc  ON sc.center_id = ts.center_id
LEFT JOIN (queue_tokens t
           JOIN queues q ON q.queue_id = t.queue_id
                        AND q.queue_date >= date('now', 'localtime', '-14 days'))
       ON t.slot_id = ts.slot_id AND t.status <> 'cancelled'
GROUP BY ts.slot_id
ORDER BY sc.name, ts.start_time;

-- name: frequent_customers
-- title: Most frequent customers
-- concepts: GROUP BY with HAVING, ROW_NUMBER(), correlated subquery
-- description: Customers with the most visits, their favourite center and how often they leave feedback.
SELECT ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank,
       u.full_name                                AS customer,
       COUNT(*)                                   AS visits,
       SUM(t.status = 'completed')                AS served,
       (SELECT sc.name
          FROM queue_tokens t2
          JOIN queues q2          ON q2.queue_id = t2.queue_id
          JOIN service_types st2  ON st2.service_type_id = q2.service_type_id
          JOIN service_centers sc ON sc.center_id = st2.center_id
         WHERE t2.user_id = u.user_id
         GROUP BY sc.center_id
         ORDER BY COUNT(*) DESC
         LIMIT 1)                                 AS favourite_center,
       COUNT(f.feedback_id)                       AS feedback_given
FROM users u
JOIN queue_tokens t   ON t.user_id = u.user_id
LEFT JOIN feedback f  ON f.token_id = t.token_id
WHERE u.role = 'customer'
GROUP BY u.user_id
HAVING COUNT(*) >= 5
ORDER BY visits DESC
LIMIT 15;

-- name: counter_load_today
-- title: Counter load today
-- concepts: LEFT JOIN with filter in ON clause, SUM of durations
-- description: Tokens handled and minutes spent serving at every counter today, including idle counters.
SELECT sc.name                                                        AS center,
       c.label                                                        AS counter,
       c.status,
       COALESCE(u.full_name, '-')                                     AS staff,
       COUNT(sr.record_id)                                            AS tokens_today,
       ROUND(COALESCE(SUM((julianday(COALESCE(sr.ended_at, datetime('now', 'localtime')))
                           - julianday(sr.started_at)) * 1440), 0), 1) AS busy_minutes
FROM counters c
JOIN service_centers sc      ON sc.center_id = c.center_id
LEFT JOIN service_staff ss   ON ss.counter_id = c.counter_id
LEFT JOIN users u            ON u.user_id = ss.user_id
LEFT JOIN service_records sr ON sr.counter_id = c.counter_id
                            AND sr.started_at >= date('now', 'localtime')
GROUP BY c.counter_id
ORDER BY sc.name, c.counter_number;

-- name: pending_feedback
-- title: Served tokens still waiting for feedback (last 7 days)
-- concepts: anti-join with NOT EXISTS
-- description: Completed tokens that never received a rating - candidates for a reminder notification.
SELECT td.token_code,
       td.customer_name,
       td.center_name,
       td.service_name,
       td.updated_at AS served_at
FROM v_token_details td
WHERE td.status = 'completed'
  AND td.queue_date >= date('now', 'localtime', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.token_id = td.token_id)
ORDER BY td.updated_at DESC
LIMIT 50;

-- name: inactive_customers
-- title: Registered customers who never joined a queue
-- concepts: LEFT JOIN ... IS NULL (outer-join anti pattern)
-- description: Accounts that were created but have no tokens at all.
SELECT u.full_name, u.email, u.created_at
FROM users u
LEFT JOIN queue_tokens t ON t.user_id = u.user_id
WHERE u.role = 'customer' AND t.token_id IS NULL
ORDER BY u.created_at DESC;

-- name: status_transition_audit
-- title: Status change audit trail (latest 40)
-- concepts: audit table filled by trigger, self-describing JOINs
-- description: The most recent token status transitions with who performed them.
SELECT h.changed_at,
       td.token_code,
       td.center_name,
       COALESCE(h.from_status, '(new)') AS from_status,
       h.to_status,
       COALESCE(u.full_name, 'system')  AS changed_by
FROM queue_status_history h
JOIN v_token_details td ON td.token_id = h.token_id
LEFT JOIN users u       ON u.user_id = h.changed_by
ORDER BY h.history_id DESC
LIMIT 40;

-- name: notification_engagement
-- title: Notification read rate by type
-- concepts: aggregate ratio, AVG over a 0/1 flag
-- description: How many notifications of each type were sent and what share was read.
SELECT type,
       COUNT(*)                      AS sent,
       SUM(is_read)                  AS read,
       ROUND(100.0 * AVG(is_read), 1) AS read_pct,
       MAX(created_at)               AS last_sent
FROM notifications
GROUP BY type
ORDER BY sent DESC;
