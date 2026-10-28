-- =====================================================================
--  Queue Without Standing - Triggers
--  Business rules that must hold no matter which program writes the data.
--  Messages prefixed with "QWS:" are shown to the end user by the API.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Cross-table consistency: entities that hang off a center must agree
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_counter_services_same_center
BEFORE INSERT ON counter_services
BEGIN
    SELECT RAISE(ABORT, 'QWS: Counter and service type must belong to the same service center')
    WHERE (SELECT center_id FROM counters WHERE counter_id = NEW.counter_id)
       <> (SELECT center_id FROM service_types WHERE service_type_id = NEW.service_type_id);
END;

CREATE TRIGGER trg_staff_validate_insert
BEFORE INSERT ON service_staff
BEGIN
    SELECT RAISE(ABORT, 'QWS: Only users with the staff role can be registered as service staff')
    WHERE (SELECT role FROM users WHERE user_id = NEW.user_id) <> 'staff';
    SELECT RAISE(ABORT, 'QWS: Assigned counter belongs to a different service center')
    WHERE NEW.counter_id IS NOT NULL
      AND (SELECT center_id FROM counters WHERE counter_id = NEW.counter_id) <> NEW.center_id;
END;

CREATE TRIGGER trg_users_staff_role_locked
BEFORE UPDATE OF role ON users
WHEN OLD.role = 'staff' AND NEW.role <> 'staff'
BEGIN
    SELECT RAISE(ABORT, 'QWS: Remove the staff profile before changing this user''s role')
    WHERE EXISTS (SELECT 1 FROM service_staff WHERE user_id = NEW.user_id);
END;

-- A counter or service never moves to another center (its links would break)
CREATE TRIGGER trg_counters_center_immutable
BEFORE UPDATE OF center_id ON counters
WHEN NEW.center_id <> OLD.center_id
BEGIN
    SELECT RAISE(ABORT, 'QWS: A counter cannot be moved to another service center');
END;

CREATE TRIGGER trg_service_types_center_immutable
BEFORE UPDATE OF center_id ON service_types
WHEN NEW.center_id <> OLD.center_id
BEGIN
    SELECT RAISE(ABORT, 'QWS: A service cannot be moved to another service center');
END;

CREATE TRIGGER trg_staff_validate_update
BEFORE UPDATE OF center_id, counter_id ON service_staff
BEGIN
    SELECT RAISE(ABORT, 'QWS: Assigned counter belongs to a different service center')
    WHERE NEW.counter_id IS NOT NULL
      AND (SELECT center_id FROM counters WHERE counter_id = NEW.counter_id) <> NEW.center_id;
END;

-- ---------------------------------------------------------------------
-- Token admission control: open queue, capacity, valid time slot
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_tokens_validate_insert
BEFORE INSERT ON queue_tokens
BEGIN
    SELECT RAISE(ABORT, 'QWS: A new token must start in the waiting state')
    WHERE NEW.status <> 'waiting';

    SELECT RAISE(ABORT, 'QWS: This account is inactive')
    WHERE (SELECT is_active FROM users WHERE user_id = NEW.user_id) = 0;

    SELECT RAISE(ABORT, 'QWS: This queue is not accepting new tokens right now')
    WHERE (SELECT status FROM queues WHERE queue_id = NEW.queue_id) <> 'open';

    SELECT RAISE(ABORT, 'QWS: This queue has reached its daily capacity')
    WHERE (SELECT COUNT(*) FROM queue_tokens WHERE queue_id = NEW.queue_id AND status <> 'cancelled')
       >= (SELECT max_tokens FROM queues WHERE queue_id = NEW.queue_id);

    SELECT RAISE(ABORT, 'QWS: The selected time slot does not belong to this service center')
    WHERE NEW.slot_id IS NOT NULL
      AND NOT EXISTS (
            SELECT 1
            FROM queues q
            JOIN service_types st ON st.service_type_id = q.service_type_id
            JOIN time_slots ts    ON ts.center_id = st.center_id
            WHERE q.queue_id = NEW.queue_id AND ts.slot_id = NEW.slot_id);

    SELECT RAISE(ABORT, 'QWS: The selected time slot is fully booked')
    WHERE NEW.slot_id IS NOT NULL
      AND (SELECT COUNT(*)
           FROM queue_tokens t
           JOIN queues q ON q.queue_id = t.queue_id
           WHERE t.slot_id = NEW.slot_id
             AND t.status <> 'cancelled'
             AND q.queue_date = (SELECT queue_date FROM queues WHERE queue_id = NEW.queue_id))
       >= (SELECT max_tokens FROM time_slots WHERE slot_id = NEW.slot_id);
END;

-- Identity of a token never changes once issued
CREATE TRIGGER trg_tokens_immutable_identity
BEFORE UPDATE OF queue_id, user_id, token_number, issued_at ON queue_tokens
WHEN NEW.queue_id <> OLD.queue_id
  OR NEW.user_id <> OLD.user_id
  OR NEW.token_number <> OLD.token_number
  OR NEW.issued_at <> OLD.issued_at
BEGIN
    SELECT RAISE(ABORT, 'QWS: Token identity fields cannot be modified');
END;

-- ---------------------------------------------------------------------
-- Token life-cycle state machine
--
--   waiting --> called --> serving --> completed
--      |          |  \
--      |          |   +--> skipped --> waiting (re-queued)
--      |          |            \-----> no_show / cancelled
--      |          +--> no_show / cancelled
--      +--> cancelled
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_tokens_status_transition
BEFORE UPDATE OF status ON queue_tokens
WHEN OLD.status <> NEW.status
BEGIN
    SELECT RAISE(ABORT, 'QWS: Invalid token status transition')
    WHERE NOT (
           (OLD.status = 'waiting' AND NEW.status IN ('called', 'cancelled'))
        OR (OLD.status = 'called'  AND NEW.status IN ('serving', 'skipped', 'no_show', 'cancelled'))
        OR (OLD.status = 'serving' AND NEW.status = 'completed')
        OR (OLD.status = 'skipped' AND NEW.status IN ('waiting', 'no_show', 'cancelled'))
    );

    -- a token may only be called to an open counter that offers its service type
    SELECT RAISE(ABORT, 'QWS: This counter does not serve that service type')
    WHERE NEW.status = 'called'
      AND NOT EXISTS (
            SELECT 1
            FROM queues q
            JOIN counter_services cs ON cs.service_type_id = q.service_type_id
            WHERE q.queue_id = NEW.queue_id AND cs.counter_id = NEW.counter_id);

    SELECT RAISE(ABORT, 'QWS: The counter must be open to call tokens')
    WHERE NEW.status = 'called'
      AND (SELECT status FROM counters WHERE counter_id = NEW.counter_id) <> 'open';
END;

-- Re-pointing a token at another counter or slot must respect the same rules
CREATE TRIGGER trg_tokens_validate_links
BEFORE UPDATE OF counter_id, slot_id ON queue_tokens
BEGIN
    SELECT RAISE(ABORT, 'QWS: This counter does not serve that service type')
    WHERE NEW.counter_id IS NOT NULL
      AND NEW.counter_id IS NOT OLD.counter_id
      AND NOT EXISTS (
            SELECT 1
            FROM queues q
            JOIN counter_services cs ON cs.service_type_id = q.service_type_id
            WHERE q.queue_id = NEW.queue_id AND cs.counter_id = NEW.counter_id);

    SELECT RAISE(ABORT, 'QWS: The selected time slot does not belong to this service center')
    WHERE NEW.slot_id IS NOT NULL
      AND NEW.slot_id IS NOT OLD.slot_id
      AND NOT EXISTS (
            SELECT 1
            FROM queues q
            JOIN service_types st ON st.service_type_id = q.service_type_id
            JOIN time_slots ts    ON ts.center_id = st.center_id
            WHERE q.queue_id = NEW.queue_id AND ts.slot_id = NEW.slot_id);
END;

-- ---------------------------------------------------------------------
-- Audit trail + notifications (written in the same transaction as the change)
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_tokens_after_insert
AFTER INSERT ON queue_tokens
BEGIN
    INSERT INTO queue_status_history (token_id, from_status, to_status, changed_by, changed_at)
    VALUES (NEW.token_id, NULL, NEW.status, NEW.updated_by, NEW.issued_at);

    INSERT INTO notifications (user_id, token_id, type, message, created_at)
    SELECT NEW.user_id, NEW.token_id, 'token_issued',
           'Token ' || st.code || '-' || printf('%03d', NEW.token_number) || ' issued for '
               || st.name || ' at ' || sc.name || '.',
           NEW.issued_at
    FROM queues q
    JOIN service_types st   ON st.service_type_id = q.service_type_id
    JOIN service_centers sc ON sc.center_id = st.center_id
    WHERE q.queue_id = NEW.queue_id;
END;

CREATE TRIGGER trg_tokens_after_status_change
AFTER UPDATE OF status ON queue_tokens
WHEN OLD.status <> NEW.status
BEGIN
    INSERT INTO queue_status_history (token_id, from_status, to_status, changed_by, changed_at)
    VALUES (NEW.token_id, OLD.status, NEW.status, NEW.updated_by, NEW.updated_at);

    INSERT INTO notifications (user_id, token_id, type, message, created_at)
    SELECT NEW.user_id, NEW.token_id,
           CASE NEW.status WHEN 'waiting' THEN 'requeued' ELSE NEW.status END,
           'Token ' || st.code || '-' || printf('%03d', NEW.token_number) ||
           CASE NEW.status
               WHEN 'called'    THEN ' is being called at ' || COALESCE(c.label, 'the counter') || ', ' || sc.name || '. Please proceed now.'
               WHEN 'completed' THEN ' has been served at ' || sc.name || '. Tell us how it went!'
               WHEN 'skipped'   THEN ' was skipped because you were not at the counter. Reach the counter soon to be re-queued.'
               WHEN 'cancelled' THEN ' was cancelled.'
               WHEN 'no_show'   THEN ' was marked as a no-show.'
               WHEN 'waiting'   THEN ' is back in the queue.'
           END,
           NEW.updated_at
    FROM queues q
    JOIN service_types st   ON st.service_type_id = q.service_type_id
    JOIN service_centers sc ON sc.center_id = st.center_id
    LEFT JOIN counters c    ON c.counter_id = NEW.counter_id
    WHERE q.queue_id = NEW.queue_id
      AND NEW.status IN ('called', 'completed', 'skipped', 'cancelled', 'no_show', 'waiting');
END;

-- ---------------------------------------------------------------------
-- Service records must reference a counter of the token's own center
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_service_records_validate
BEFORE INSERT ON service_records
BEGIN
    SELECT RAISE(ABORT, 'QWS: A service record can only be opened for a token that is being served')
    WHERE (SELECT status FROM queue_tokens WHERE token_id = NEW.token_id) <> 'serving';

    SELECT RAISE(ABORT, 'QWS: Staff member works at a different service center')
    WHERE (SELECT center_id FROM service_staff WHERE staff_id = NEW.staff_id)
       <> (SELECT center_id FROM counters WHERE counter_id = NEW.counter_id);

    SELECT RAISE(ABORT, 'QWS: Service record counter belongs to a different service center')
    WHERE (SELECT center_id FROM counters WHERE counter_id = NEW.counter_id)
       <> (SELECT st.center_id
           FROM queue_tokens t
           JOIN queues q         ON q.queue_id = t.queue_id
           JOIN service_types st ON st.service_type_id = q.service_type_id
           WHERE t.token_id = NEW.token_id);
END;

-- ---------------------------------------------------------------------
-- Feedback only for tokens that were actually served
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_feedback_completed_only
BEFORE INSERT ON feedback
BEGIN
    SELECT RAISE(ABORT, 'QWS: Feedback can only be given for completed tokens')
    WHERE (SELECT status FROM queue_tokens WHERE token_id = NEW.token_id) <> 'completed';
END;

-- ---------------------------------------------------------------------
-- The audit trail is append-only
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_history_no_update
BEFORE UPDATE ON queue_status_history
BEGIN
    SELECT RAISE(ABORT, 'QWS: The status history is append-only');
END;

CREATE TRIGGER trg_history_no_delete
BEFORE DELETE ON queue_status_history
WHEN EXISTS (SELECT 1 FROM queue_tokens WHERE token_id = OLD.token_id)
BEGIN
    SELECT RAISE(ABORT, 'QWS: The status history is append-only');
END;
