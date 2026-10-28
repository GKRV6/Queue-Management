-- =====================================================================
--  Queue Without Standing - Relational Schema (SQLite 3.45+)
--  Normalised to 3NF / BCNF. See docs/DATABASE.md for the ER diagram
--  and the normalisation argument for every table.
--
--  Conventions
--    * Surrogate INTEGER PRIMARY KEYs (rowid aliases) on every entity.
--    * Natural keys are protected with UNIQUE constraints.
--    * Timestamps are local-time ISO strings 'YYYY-MM-DD HH:MM:SS'.
--    * Clock times are 'HH:MM' strings; dates are 'YYYY-MM-DD'.
--    * Booleans are INTEGER 0/1 guarded by CHECK constraints.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 1. USER  - every person who logs in (customer, staff or admin)
-- ---------------------------------------------------------------------
CREATE TABLE users (
    user_id        INTEGER PRIMARY KEY,
    full_name      TEXT    NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 100),
    email          TEXT    NOT NULL UNIQUE COLLATE NOCASE
                           CHECK (email LIKE '_%@_%._%' AND length(email) <= 120),
    phone          TEXT    CHECK (phone IS NULL OR (length(phone) BETWEEN 7 AND 15 AND phone NOT GLOB '*[^0-9+]*')),
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL DEFAULT 'customer'
                           CHECK (role IN ('customer', 'staff', 'admin')),
    is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------------------------------------------------------------------
-- 2. SERVICE CENTER - canteen, photocopy shop, clinic, office ...
-- ---------------------------------------------------------------------
CREATE TABLE service_centers (
    center_id     INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE CHECK (length(trim(name)) >= 2),
    category      TEXT    NOT NULL
                          CHECK (category IN ('canteen', 'photocopy', 'clinic', 'office', 'library', 'other')),
    location      TEXT    NOT NULL,
    description   TEXT,
    opening_time  TEXT    NOT NULL CHECK (opening_time GLOB '[0-2][0-9]:[0-5][0-9]' AND opening_time < '24:00'),
    closing_time  TEXT    NOT NULL CHECK (closing_time GLOB '[0-2][0-9]:[0-5][0-9]' AND closing_time < '24:00'),
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    CHECK (closing_time > opening_time)
);

-- ---------------------------------------------------------------------
-- 3. SERVICE TYPE - what a center offers (Meals, Photocopy, Consultation)
--    code is used as the token prefix, e.g. "M-014".
-- ---------------------------------------------------------------------
CREATE TABLE service_types (
    service_type_id      INTEGER PRIMARY KEY,
    center_id            INTEGER NOT NULL REFERENCES service_centers (center_id) ON DELETE CASCADE,
    name                 TEXT    NOT NULL CHECK (length(trim(name)) >= 2),
    code                 TEXT    NOT NULL CHECK (length(code) BETWEEN 1 AND 3 AND code NOT GLOB '*[^A-Z]*'),
    description          TEXT,
    avg_service_minutes  REAL    NOT NULL CHECK (avg_service_minutes > 0 AND avg_service_minutes <= 240),
    fee                  REAL    NOT NULL DEFAULT 0 CHECK (fee >= 0),
    is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    UNIQUE (center_id, name),
    UNIQUE (center_id, code)
);

-- ---------------------------------------------------------------------
-- 4. COUNTER - a physical service window inside a center
-- ---------------------------------------------------------------------
CREATE TABLE counters (
    counter_id      INTEGER PRIMARY KEY,
    center_id       INTEGER NOT NULL REFERENCES service_centers (center_id) ON DELETE CASCADE,
    counter_number  INTEGER NOT NULL CHECK (counter_number > 0),
    label           TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'paused', 'closed')),
    UNIQUE (center_id, counter_number)
);

-- Associative entity resolving the M:N between COUNTER and SERVICE TYPE
-- (a counter can handle several service types; a type can be served at several counters).
CREATE TABLE counter_services (
    counter_id       INTEGER NOT NULL REFERENCES counters (counter_id) ON DELETE CASCADE,
    service_type_id  INTEGER NOT NULL REFERENCES service_types (service_type_id) ON DELETE CASCADE,
    PRIMARY KEY (counter_id, service_type_id)
);

-- ---------------------------------------------------------------------
-- 5. SERVICE STAFF - specialisation of USER (1:1) working at a center
--    counter_id is UNIQUE: a counter is manned by at most one staff member.
--    "On duty" is not stored: it is derived from the counter's status.
-- ---------------------------------------------------------------------
CREATE TABLE service_staff (
    staff_id     INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL UNIQUE REFERENCES users (user_id) ON DELETE CASCADE,
    center_id    INTEGER NOT NULL REFERENCES service_centers (center_id) ON DELETE RESTRICT,
    counter_id   INTEGER UNIQUE REFERENCES counters (counter_id) ON DELETE SET NULL,
    designation  TEXT    NOT NULL,
    joined_on    TEXT    NOT NULL DEFAULT (date('now', 'localtime'))
);

-- ---------------------------------------------------------------------
-- 6. TIME SLOT - recurring daily booking windows of a center with capacity
-- ---------------------------------------------------------------------
CREATE TABLE time_slots (
    slot_id     INTEGER PRIMARY KEY,
    center_id   INTEGER NOT NULL REFERENCES service_centers (center_id) ON DELETE CASCADE,
    start_time  TEXT    NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time < '24:00'),
    end_time    TEXT    NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time < '24:00'),
    max_tokens  INTEGER NOT NULL CHECK (max_tokens > 0),
    CHECK (end_time > start_time),
    UNIQUE (center_id, start_time)
);

-- ---------------------------------------------------------------------
-- 7. QUEUE - one queue per service type per day
-- ---------------------------------------------------------------------
CREATE TABLE queues (
    queue_id         INTEGER PRIMARY KEY,
    service_type_id  INTEGER NOT NULL REFERENCES service_types (service_type_id) ON DELETE RESTRICT,
    queue_date       TEXT    NOT NULL CHECK (date(queue_date) IS queue_date),
    status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paused', 'closed')),
    max_tokens       INTEGER NOT NULL DEFAULT 300 CHECK (max_tokens > 0),
    opened_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    closed_at        TEXT,
    UNIQUE (service_type_id, queue_date),
    CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- 8. QUEUE TOKEN - a customer's digital place in a queue
--    updated_by/updated_at record the actor of the latest change; the
--    status-history trigger copies them into queue_status_history.
-- ---------------------------------------------------------------------
CREATE TABLE queue_tokens (
    token_id      INTEGER PRIMARY KEY,
    queue_id      INTEGER NOT NULL REFERENCES queues (queue_id) ON DELETE RESTRICT,
    user_id       INTEGER NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    token_number  INTEGER NOT NULL CHECK (token_number > 0),
    slot_id       INTEGER REFERENCES time_slots (slot_id) ON DELETE SET NULL,
    priority      TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'priority')),
    status        TEXT    NOT NULL DEFAULT 'waiting'
                          CHECK (status IN ('waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'no_show')),
    counter_id    INTEGER REFERENCES counters (counter_id) ON DELETE SET NULL,
    notes         TEXT    CHECK (notes IS NULL OR length(notes) <= 200),
    issued_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_by    INTEGER REFERENCES users (user_id) ON DELETE SET NULL,
    UNIQUE (queue_id, token_number),
    -- a token that is being called/served must be bound to a counter
    CHECK (status NOT IN ('called', 'serving') OR counter_id IS NOT NULL),
    CHECK (updated_at >= issued_at)
);

-- ---------------------------------------------------------------------
-- 9. SERVICE RECORD - the actual service event of a token (1:1 with token)
-- ---------------------------------------------------------------------
CREATE TABLE service_records (
    record_id   INTEGER PRIMARY KEY,
    token_id    INTEGER NOT NULL UNIQUE REFERENCES queue_tokens (token_id) ON DELETE CASCADE,
    staff_id    INTEGER NOT NULL REFERENCES service_staff (staff_id) ON DELETE RESTRICT,
    counter_id  INTEGER NOT NULL REFERENCES counters (counter_id) ON DELETE RESTRICT,
    started_at  TEXT    NOT NULL,
    ended_at    TEXT,
    remarks     TEXT    CHECK (remarks IS NULL OR length(remarks) <= 300),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- ---------------------------------------------------------------------
-- 10. QUEUE STATUS HISTORY - append-only audit trail (filled by triggers)
-- ---------------------------------------------------------------------
CREATE TABLE queue_status_history (
    history_id   INTEGER PRIMARY KEY,
    token_id     INTEGER NOT NULL REFERENCES queue_tokens (token_id) ON DELETE CASCADE,
    from_status  TEXT,
    to_status    TEXT    NOT NULL,
    changed_by   INTEGER REFERENCES users (user_id) ON DELETE SET NULL,
    changed_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    CHECK (from_status IS NULL OR from_status <> to_status)
);

-- ---------------------------------------------------------------------
-- 11. FEEDBACK - one rating per completed token
--     (the customer is reached through the token: no transitive user_id)
-- ---------------------------------------------------------------------
CREATE TABLE feedback (
    feedback_id   INTEGER PRIMARY KEY,
    token_id      INTEGER NOT NULL UNIQUE REFERENCES queue_tokens (token_id) ON DELETE CASCADE,
    rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment       TEXT    CHECK (comment IS NULL OR length(comment) <= 500),
    submitted_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------------------------------------------------------------------
-- 12. NOTIFICATION - in-app messages to a user, optionally about a token
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
    notification_id  INTEGER PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    token_id         INTEGER REFERENCES queue_tokens (token_id) ON DELETE CASCADE,
    type             TEXT    NOT NULL
                             CHECK (type IN ('token_issued', 'turn_near', 'called', 'skipped', 'completed',
                                             'cancelled', 'no_show', 'requeued', 'queue_update', 'system')),
    message          TEXT    NOT NULL,
    is_read          INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at       TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- =====================================================================
--  Indexes - chosen for the hot paths (live queue, call-next, analytics)
-- =====================================================================
CREATE INDEX ix_service_types_center   ON service_types (center_id);
CREATE INDEX ix_counters_center        ON counters (center_id);
CREATE INDEX ix_counter_services_type  ON counter_services (service_type_id);
CREATE INDEX ix_staff_center           ON service_staff (center_id);
CREATE INDEX ix_queues_date            ON queues (queue_date, status);
CREATE INDEX ix_tokens_queue_status    ON queue_tokens (queue_id, status, priority, token_number);
CREATE INDEX ix_tokens_user            ON queue_tokens (user_id, issued_at);
CREATE INDEX ix_tokens_issued          ON queue_tokens (issued_at);
CREATE INDEX ix_tokens_slot            ON queue_tokens (slot_id) WHERE slot_id IS NOT NULL;
CREATE INDEX ix_records_staff          ON service_records (staff_id, started_at);
CREATE INDEX ix_records_counter        ON service_records (counter_id, started_at);
CREATE INDEX ix_history_token          ON queue_status_history (token_id, changed_at);
CREATE INDEX ix_history_status_time    ON queue_status_history (to_status, changed_at);
CREATE INDEX ix_notifications_user     ON notifications (user_id, is_read, created_at);

-- Business rules expressed as partial UNIQUE indexes:
-- a customer may hold only one live token in the same queue ...
CREATE UNIQUE INDEX ux_tokens_one_live_per_user
    ON queue_tokens (queue_id, user_id) WHERE status IN ('waiting', 'called', 'serving', 'skipped');
-- ... and a counter can only call / serve one token at a time.
CREATE UNIQUE INDEX ux_tokens_one_active_per_counter
    ON queue_tokens (counter_id) WHERE status IN ('called', 'serving');
