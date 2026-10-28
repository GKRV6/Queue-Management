'use strict';

const { notFound } = require('../errors');

function listCenters(db, { includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  return db.prepare(`SELECT * FROM v_center_overview ${where} ORDER BY name`).all();
}

function getCenter(db, centerId) {
  const center = db.prepare('SELECT * FROM v_center_overview WHERE center_id = ?').get(centerId);
  if (!center || !center.is_active) throw notFound('Service center not found');

  const services = db.prepare(`
    SELECT ls.*, st.description, st.avg_service_minutes AS configured_minutes
    FROM v_service_live_status ls
    JOIN service_types st ON st.service_type_id = ls.service_type_id
    WHERE ls.center_id = ? AND ls.is_active = 1
    ORDER BY ls.name`).all(centerId);

  const slots = db.prepare(`
    SELECT ts.slot_id, ts.start_time, ts.end_time, ts.max_tokens,
           ts.max_tokens - (
               SELECT COUNT(*) FROM queue_tokens t
               JOIN queues q ON q.queue_id = t.queue_id
               WHERE t.slot_id = ts.slot_id
                 AND t.status <> 'cancelled'
                 AND q.queue_date = date('now', 'localtime')) AS remaining,
           ts.end_time > strftime('%H:%M', 'now', 'localtime') AS bookable
    FROM time_slots ts
    WHERE ts.center_id = ?
    ORDER BY ts.start_time`).all(centerId);

  // "Now serving" display board: what every counter is doing right now
  const counters = db.prepare(`
    SELECT c.counter_id, c.counter_number, c.label, c.status,
           d.token_code AS current_token, d.status AS current_status,
           (SELECT group_concat(st.name, ', ')
              FROM counter_services cs
              JOIN service_types st ON st.service_type_id = cs.service_type_id
             WHERE cs.counter_id = c.counter_id) AS services
    FROM counters c
    LEFT JOIN v_token_details d ON d.counter_id = c.counter_id AND d.status IN ('called', 'serving')
    WHERE c.center_id = ?
    ORDER BY c.counter_number`).all(centerId);

  return { ...center, services, slots, counters };
}

function listNotifications(db, userId, limit = 40) {
  const items = db.prepare(`
    SELECT notification_id, token_id, type, message, is_read, created_at
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC, notification_id DESC
    LIMIT ?`).all(userId, limit);
  const { unread } = db
    .prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(userId);
  return { items, unread };
}

function markNotificationRead(db, userId, notificationId) {
  const { changes } = db
    .prepare('UPDATE notifications SET is_read = 1 WHERE notification_id = ? AND user_id = ?')
    .run(notificationId, userId);
  if (!changes) throw notFound('Notification not found');
}

function markAllNotificationsRead(db, userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
}

module.exports = { listCenters, getCenter, listNotifications, markNotificationRead, markAllNotificationsRead };
