'use strict';

/**
 * Generates realistic sample data by simulating queue traffic day by day.
 * Every token goes through the real state machine (INSERT, then UPDATEs), so
 * status history and notifications are produced by the database triggers,
 * exactly as they are in live use.
 */

const { transaction } = require('../db');
const { hashPassword } = require('../auth');
const {
  DEMO_ACCOUNTS, CENTERS, STAFF_NAMES, CUSTOMER_NAMES, IDLE_CUSTOMER_NAMES, FEEDBACK_COMMENTS, generatedCustomerNames,
} = require('./seedData');
const { TURN_NEAR_POSITION } = require('../services/queueService');

const CANCEL_RATE = 0.04;
const NO_SHOW_RATE = 0.05;
const FEEDBACK_RATE = 0.55;
const DEMO_CUSTOMER_SHARE = 0.0015;
const NOTIFICATION_READ_PCT = 86;
const MS_PER_MIN = 60000;

// ---------------------------------------------------------------- helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fmtDate = (d) => fmt(d).slice(0, 10);
const addMin = (d, minutes) => new Date(d.getTime() + minutes * MS_PER_MIN);
const minutesBetween = (a, b) => (b.getTime() - a.getTime()) / MS_PER_MIN;

function atTime(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

function makeRandom(seed) {
  const next = mulberry32(seed);
  const rnd = {
    next,
    between: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    poisson(lambda) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k += 1;
        p *= next();
      } while (p > limit);
      return k - 1;
    },
    weighted(items, weightOf) {
      const total = items.reduce((s, it) => s + weightOf(it), 0);
      let r = next() * total;
      for (const it of items) {
        r -= weightOf(it);
        if (r <= 0) return it;
      }
      return items[items.length - 1];
    },
  };
  return rnd;
}

const emailFor = (name, domain) =>
  `${name.toLowerCase().replace(/^dr\.\s*/, '').replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@${domain}`;

// ------------------------------------------------------- reference data
function insertReferenceData(db, rnd) {
  const insertUser = db.prepare(`
    INSERT INTO users (full_name, email, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const phone = () => `9${rnd.int(100000000, 999999999)}`;
  const created = fmt(addMin(new Date(), -60 * 24 * 60));

  const adminId = Number(insertUser.run(
    DEMO_ACCOUNTS.admin.name, DEMO_ACCOUNTS.admin.email, phone(), hashPassword(DEMO_ACCOUNTS.admin.password), 'admin', created,
  ).lastInsertRowid);

  const customerHash = hashPassword(DEMO_ACCOUNTS.customer.password);
  const demoCustomerId = Number(insertUser.run(
    DEMO_ACCOUNTS.customer.name, DEMO_ACCOUNTS.customer.email, phone(), customerHash, 'customer', created,
  ).lastInsertRowid);
  const customers = [demoCustomerId];
  for (const name of [...CUSTOMER_NAMES, ...generatedCustomerNames()]) {
    customers.push(Number(insertUser.run(name, emailFor(name, 'student.qws.edu'), phone(), customerHash, 'customer', created).lastInsertRowid));
  }
  for (const name of IDLE_CUSTOMER_NAMES) {
    insertUser.run(name, emailFor(name, 'student.qws.edu'), phone(), customerHash, 'customer', fmt(addMin(new Date(), -rnd.int(60, 4000))));
  }

  const staffHash = hashPassword(DEMO_ACCOUNTS.staff.password);
  const insertCenter = db.prepare(`
    INSERT INTO service_centers (name, category, location, description, opening_time, closing_time, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertService = db.prepare(`
    INSERT INTO service_types (center_id, name, code, description, avg_service_minutes, fee) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertCounter = db.prepare(`
    INSERT INTO counters (center_id, counter_number, label, status) VALUES (?, ?, ?, 'open')`);
  const insertCounterService = db.prepare('INSERT INTO counter_services (counter_id, service_type_id) VALUES (?, ?)');
  const insertStaff = db.prepare(`
    INSERT INTO service_staff (user_id, center_id, counter_id, designation, joined_on) VALUES (?, ?, ?, ?, ?)`);
  const insertSlot = db.prepare('INSERT INTO time_slots (center_id, start_time, end_time, max_tokens) VALUES (?, ?, ?, ?)');

  let staffIdx = 0;
  const centers = CENTERS.map((def) => {
    const centerId = Number(insertCenter.run(def.name, def.category, def.location, def.description, def.open, def.close, created).lastInsertRowid);
    const services = def.services.map((s) => ({
      ...s,
      serviceTypeId: Number(insertService.run(centerId, s.name, s.code, s.description, s.avg, s.fee).lastInsertRowid),
    }));
    const counters = def.counters.map((c, i) => {
      const counterId = Number(insertCounter.run(centerId, i + 1, c.label).lastInsertRowid);
      for (const code of c.services) {
        insertCounterService.run(counterId, services.find((s) => s.code === code).serviceTypeId);
      }
      const [name, designation] = STAFF_NAMES[staffIdx];
      const email = staffIdx === 0 ? DEMO_ACCOUNTS.staff.email : emailFor(name, 'qws.edu');
      staffIdx += 1;
      const userId = Number(insertUser.run(name, email, phone(), staffHash, 'staff', created).lastInsertRowid);
      const staffId = Number(insertStaff.run(userId, centerId, counterId, designation, created.slice(0, 10)).lastInsertRowid);
      return { counterId, label: c.label, codes: new Set(c.services), userId, staffId, freeAt: null };
    });
    const slots = def.slots.map(([start, end, cap]) => ({
      start, end, cap, slotId: Number(insertSlot.run(centerId, start, end, cap).lastInsertRowid),
    }));
    return { def, centerId, services, counters, slots };
  });

  return { adminId, demoCustomerId, customers, centers };
}

// ------------------------------------------------------------ simulation
/** Generates arrivals for one center on one day and runs them through the counters. */
function simulateCenterDay(center, day, rnd) {
  const factor = center.def.dayFactor[day.getDay()];
  if (!factor) return [];
  const open = atTime(day, center.def.open);
  const close = atTime(day, center.def.close);
  const slotCounts = new Map();
  const tokens = [];

  for (const [hourText, rate] of Object.entries(center.def.hourly)) {
    const hourStart = atTime(day, `${pad(Number(hourText))}:00`);
    const from = Math.max(hourStart.getTime(), open.getTime());
    const to = Math.min(addMin(hourStart, 60).getTime(), close.getTime());
    if (to <= from) continue;
    const count = rnd.poisson(rate * factor);
    for (let i = 0; i < count; i += 1) {
      const arrival = new Date(from + (to - from) * rnd.next());
      const svc = rnd.weighted(center.services, (s) => s.weight);
      tokens.push(planToken(center, svc, arrival, slotCounts, rnd));
    }
  }

  tokens.sort((a, b) => a.eligible - b.eligible);
  for (const c of center.counters) c.freeAt = open;
  for (const t of tokens) runThroughCounters(center, t, rnd);
  return tokens;
}

function planToken(center, svc, arrival, slotCounts, rnd) {
  const token = {
    svc, issue: arrival, eligible: arrival, slot: null,
    priority: svc.priorityRate && rnd.chance(svc.priorityRate) ? 'priority' : 'normal',
  };
  const slotRate = svc.slotRate ?? center.def.slotRate;
  const hhmm = `${pad(arrival.getHours())}:${pad(arrival.getMinutes())}`;
  const slot = center.slots.find((s) => hhmm >= s.start && hhmm < s.end);
  if (slot && slotRate && rnd.chance(slotRate) && (slotCounts.get(slot.slotId) || 0) < slot.cap) {
    slotCounts.set(slot.slotId, (slotCounts.get(slot.slotId) || 0) + 1);
    const slotStart = atTime(arrival, slot.start);
    token.slot = slot;
    token.eligible = addMin(slotStart, rnd.between(0, 6));
    token.issue = addMin(slotStart, -rnd.between(10, 90)); // booked ahead of time
  }
  return token;
}

function runThroughCounters(center, t, rnd) {
  if (rnd.chance(CANCEL_RATE)) {
    t.outcome = 'cancelled';
    t.cancelAt = addMin(t.eligible, rnd.between(2, 15));
    return;
  }
  const candidates = center.counters.filter((c) => c.codes.has(t.svc.code));
  const counter = candidates.reduce((best, c) => (c.freeAt < best.freeAt ? c : best));
  t.counter = counter;
  t.called = addMin(new Date(Math.max(t.eligible.getTime(), counter.freeAt.getTime())), rnd.between(0.1, 0.8));
  if (rnd.chance(NO_SHOW_RATE)) {
    t.outcome = 'no_show';
    t.skipAt = addMin(t.called, rnd.between(1.5, 3));
    t.noShowAt = addMin(t.skipAt, rnd.between(5, 15));
    counter.freeAt = t.skipAt;
    return;
  }
  t.outcome = 'completed';
  t.start = addMin(t.called, rnd.between(0.4, 1.8));
  t.end = addMin(t.start, t.svc.avg * rnd.between(0.55, 1.6));
  counter.freeAt = addMin(t.end, rnd.between(0.1, 0.4));
}

/** The status a token has at instant `now` (only matters for today). */
function statusAt(t, now) {
  if (!now) return t.outcome;
  if (t.outcome === 'cancelled') return now < t.cancelAt ? 'waiting' : 'cancelled';
  if (now < t.called) return 'waiting';
  if (t.outcome === 'no_show') {
    if (now < t.skipAt) return 'called';
    return now < t.noShowAt ? 'skipped' : 'no_show';
  }
  if (now < t.start) return 'called';
  return now < t.end ? 'serving' : 'completed';
}

const LIVE = new Set(['waiting', 'called', 'serving', 'skipped']);

/**
 * Outside opening hours there is nothing live to look at, so add a handful of
 * waiting tokens and one token at a counter to keep the dashboards meaningful.
 */
function addDemoLiveTokens(center, now, rnd) {
  const extra = [];
  for (const svc of center.services) {
    const n = Math.max(2, Math.round(6 * svc.weight * center.services.length / 1.5));
    for (let i = 0; i < n; i += 1) {
      const issue = addMin(now, -rnd.between(1, 45));
      extra.push({ svc, issue, eligible: issue, slot: null, priority: 'normal', outcome: 'completed', called: addMin(now, 999) });
    }
  }
  const counter = center.counters[0];
  const svc = center.services.find((s) => counter.codes.has(s.code));
  const issue = addMin(now, -rnd.between(15, 30));
  extra.push({
    svc, issue, eligible: issue, slot: null, priority: 'normal', outcome: 'completed', counter,
    called: addMin(now, -3), start: addMin(now, -2), end: addMin(now, 999),
  });
  return extra;
}

// -------------------------------------------------------------- writing
function prepareWriters(db) {
  return {
    insertQueue: db.prepare(`
      INSERT INTO queues (service_type_id, queue_date, opened_at) VALUES (?, ?, ?)`),
    closeQueue: db.prepare(`UPDATE queues SET status = 'closed', closed_at = ? WHERE queue_id = ?`),
    insertToken: db.prepare(`
      INSERT INTO queue_tokens (queue_id, user_id, token_number, slot_id, priority, issued_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    setStatus: db.prepare(`
      UPDATE queue_tokens SET status = ?, updated_at = ?, updated_by = ?, counter_id = COALESCE(?, counter_id)
      WHERE token_id = ?`),
    insertRecord: db.prepare(`
      INSERT INTO service_records (token_id, staff_id, counter_id, started_at) VALUES (?, ?, ?, ?)`),
    endRecord: db.prepare('UPDATE service_records SET ended_at = ? WHERE token_id = ?'),
    insertFeedback: db.prepare('INSERT INTO feedback (token_id, rating, comment, submitted_at) VALUES (?, ?, ?, ?)'),
  };
}

/** Replays a token's life up to its final status through the real state machine. */
function applyTransitions(w, t, finalStatus) {
  const steps = [];
  const staffUser = t.counter ? t.counter.userId : null;
  if (t.outcome === 'cancelled') {
    if (finalStatus === 'cancelled') steps.push(['cancelled', t.cancelAt, t.userId, null]);
  } else if (finalStatus !== 'waiting') {
    steps.push(['called', t.called, staffUser, t.counter.counterId]);
    if (t.outcome === 'no_show') {
      if (finalStatus !== 'called') steps.push(['skipped', t.skipAt, staffUser, null]);
      if (finalStatus === 'no_show') steps.push(['no_show', t.noShowAt, staffUser, null]);
    } else {
      if (finalStatus !== 'called') steps.push(['serving', t.start, staffUser, null]);
      if (finalStatus === 'completed') steps.push(['completed', t.end, staffUser, null]);
    }
  }
  for (const [status, when, by, counterId] of steps) {
    w.setStatus.run(status, fmt(when), by, counterId, t.tokenId);
    if (status === 'serving') w.insertRecord.run(t.tokenId, t.counter.staffId, t.counter.counterId, fmt(when));
    if (status === 'completed') w.endRecord.run(fmt(when), t.tokenId);
  }
}

function ratingFor(t, rnd) {
  const wait = minutesBetween(t.eligible, t.called);
  const base = wait < 5 ? 4.6 : wait < 10 ? 4.1 : wait < 20 ? 3.3 : 2.4;
  return Math.min(5, Math.max(1, Math.round(base + rnd.between(-1.1, 0.9))));
}

function writeCenterDay(db, w, ctx, center, day, tokens, now, rnd) {
  const isToday = Boolean(now);
  const open = atTime(day, center.def.open);
  const queueIds = new Map();
  const queueFor = (svc) => {
    if (!queueIds.has(svc.serviceTypeId)) {
      const openedAt = isToday && now < open ? now : open;
      queueIds.set(svc.serviceTypeId, Number(w.insertQueue.run(svc.serviceTypeId, fmtDate(day), fmt(openedAt)).lastInsertRowid));
    }
    return queueIds.get(svc.serviceTypeId);
  };

  // decide final states, then pick customers (live tokens need distinct users per queue)
  const usedLive = new Map();
  for (const t of tokens) {
    t.final = statusAt(t, now);
    const queueId = queueFor(t.svc);
    if (LIVE.has(t.final)) {
      const used = usedLive.get(queueId) || new Set([ctx.demoCustomerId]);
      usedLive.set(queueId, used);
      const free = ctx.customers.filter((id) => !used.has(id));
      t.userId = rnd.pick(free);
      used.add(t.userId);
    } else {
      t.userId = rnd.chance(DEMO_CUSTOMER_SHARE) ? ctx.demoCustomerId : rnd.pick(ctx.customers);
    }
  }

  // token numbers follow issue order inside each queue
  const ordered = [...tokens].sort((a, b) => a.issue - b.issue);
  const numbers = new Map();
  for (const t of ordered) {
    const queueId = queueFor(t.svc);
    t.queueId = queueId;
    t.number = (numbers.get(queueId) || 0) + 1;
    numbers.set(queueId, t.number);
  }

  // Each finished token is inserted and replayed to its end state before the
  // next one, so the "one live token per user/counter" indexes always hold.
  // Live tokens are written last and stay live.
  const finished = ordered.filter((t) => !LIVE.has(t.final));
  const live = ordered.filter((t) => LIVE.has(t.final));
  for (const t of [...finished, ...live]) {
    t.tokenId = Number(w.insertToken.run(
      t.queueId, t.userId, t.number, t.slot ? t.slot.slotId : null, t.priority, fmt(t.issue), fmt(t.issue), t.userId,
    ).lastInsertRowid);
    applyTransitions(w, t, t.final);
  }

  for (const t of finished) {
    if (t.final !== 'completed' || !rnd.chance(FEEDBACK_RATE)) continue;
    const submitted = addMin(t.end, rnd.between(2, 90));
    if (now && submitted > now) continue;
    const rating = ratingFor(t, rnd);
    w.insertFeedback.run(t.tokenId, rating, rnd.pick(FEEDBACK_COMMENTS[rating]), fmt(submitted));
  }

  if (!isToday) {
    const close = atTime(day, center.def.close);
    for (const queueId of queueIds.values()) w.closeQueue.run(fmt(addMin(close, 15)), queueId);
  }
  return queueIds;
}

/** Gives the demo customer a live token in the canteen meals queue. */
function giveDemoCustomerLiveToken(db, ctx, now) {
  const meals = ctx.centers[0].services.find((s) => s.code === 'M');
  const queue = db.prepare(`SELECT queue_id FROM queues WHERE service_type_id = ? AND queue_date = ?`)
    .get(meals.serviceTypeId, fmtDate(now));
  if (!queue) return;
  const { next } = db.prepare('SELECT COALESCE(MAX(token_number), 0) + 1 AS next FROM queue_tokens WHERE queue_id = ?')
    .get(queue.queue_id);
  db.prepare(`
    INSERT INTO queue_tokens (queue_id, user_id, token_number, issued_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)`).run(queue.queue_id, ctx.demoCustomerId, next, fmt(addMin(now, -1)), fmt(addMin(now, -1)), ctx.demoCustomerId);
}

function finalize(db, ctx, now) {
  // most historical notifications were read (deterministic ~86%); today's live ones stay unread
  db.prepare(`
    UPDATE notifications SET is_read = 1
    WHERE (notification_id * 7919) % 100 < ?
      AND (created_at < ?
           OR token_id IN (SELECT token_id FROM queue_tokens WHERE status IN ('completed', 'cancelled', 'no_show')))`)
    .run(NOTIFICATION_READ_PCT, fmtDate(now));
  // demo customer starts with a tidy inbox: only live-token alerts and two "please rate us" prompts unread
  db.prepare(`
    UPDATE notifications SET is_read = 1
    WHERE user_id = ? AND (token_id IS NULL OR token_id NOT IN (
      SELECT token_id FROM queue_tokens WHERE status IN ('waiting', 'called', 'serving', 'skipped')))`).run(ctx.demoCustomerId);
  db.prepare(`
    UPDATE notifications SET is_read = 0
    WHERE notification_id IN (
      SELECT n.notification_id FROM notifications n
      WHERE n.user_id = ? AND n.type = 'completed'
        AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.token_id = n.token_id)
      ORDER BY n.created_at DESC LIMIT 2)`).run(ctx.demoCustomerId);

  db.prepare(`
    INSERT INTO notifications (user_id, type, message, created_at) VALUES (?, 'system', ?, ?)`)
    .run(ctx.demoCustomerId, 'Welcome to Queue Without Standing! Join any queue from your phone and we will alert you when it is your turn.', fmt(addMin(now, -120)));

  // turn-near alerts for whoever is at the front of today's queues
  const todays = db.prepare('SELECT queue_id FROM queues WHERE queue_date = ?').all(fmtDate(now));
  const alert = db.prepare(`
    INSERT INTO notifications (user_id, token_id, type, message)
    SELECT w.user_id, w.token_id, 'turn_near',
           'Your token ' || d.token_code || ' is now #' || w.position || ' in line at ' || d.center_name || '. Please start heading to the counter.'
    FROM v_waiting_tokens w JOIN v_token_details d ON d.token_id = w.token_id
    WHERE w.queue_id = ? AND w.is_eligible = 1 AND w.position <= ?`);
  for (const { queue_id: queueId } of todays) alert.run(queueId, TURN_NEAR_POSITION);
}

/**
 * Seeds the database with `days` days of history plus today's live state.
 * Deterministic for a given seed and `now`.
 */
function seedDatabase(db, { days = 21, now = new Date(), seed = 20251028 } = {}) {
  const rnd = makeRandom(seed);
  return transaction(db, () => {
    const ctx = insertReferenceData(db, rnd);
    const w = prepareWriters(db);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    for (let back = days; back >= 0; back -= 1) {
      const day = new Date(today);
      day.setDate(day.getDate() - back);
      const isToday = back === 0;
      for (const center of ctx.centers) {
        let tokens = simulateCenterDay(center, day, rnd);
        if (isToday) {
          tokens = tokens.filter((t) => t.issue <= now);
          const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
          const openNow = hhmm >= center.def.open && hhmm < center.def.close && center.def.dayFactor[day.getDay()] > 0;
          if (!openNow) {
            // a closed center has nothing left at its counters - only demo tokens are live
            tokens = tokens.filter((t) => !LIVE.has(statusAt(t, now)));
            tokens.push(...addDemoLiveTokens(center, now, rnd));
          }
        }
        writeCenterDay(db, w, ctx, center, day, tokens, isToday ? now : null, rnd);
      }
    }

    giveDemoCustomerLiveToken(db, ctx, now);
    finalize(db, ctx, now);
    return {
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      tokens: db.prepare('SELECT COUNT(*) AS n FROM queue_tokens').get().n,
    };
  });
}

module.exports = { seedDatabase, DEMO_ACCOUNTS };
