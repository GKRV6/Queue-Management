import { api } from '../api.js';
import {
  html, render, toast, confirmDialog, withBusy, statusBadge, minutesLabel, fmtNum, fmtDateTime, table, stars,
} from '../ui.js';
import { icon, appIcon } from '../icons.js';
import { heatmap, barChart, hbars, hourLabel } from '../charts.js';

const OVERVIEW_POLL_MS = 10000;

const kpi = (label, value, foot = '') =>
  html`<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div>${foot ? html`<div class="foot">${foot}</div>` : ''}</div>`;

// ------------------------------------------------------------------ overview
export async function overviewView(ctx) {
  ctx.setTitle('Overview', 'Today across every service center');
  const load = async () => {
    const o = await api.get('/api/admin/overview');
    if (!ctx.isCurrent()) return;
    render(ctx.el, html`
      <div class="kpis">
        ${kpi('Tokens issued today', fmtNum(o.issued_today), `${fmtNum(o.all_time_tokens)} all time`)}
        ${kpi('Waiting right now', fmtNum(o.waiting_now), `${o.at_counters} at counters`)}
        ${kpi('Served today', fmtNum(o.served_today))}
        ${kpi('Average wait today', o.avg_wait_today === null ? '-' : `${o.avg_wait_today} min`)}
        ${kpi('No-shows today', fmtNum(o.no_show_today), `${o.cancelled_today} cancelled`)}
        ${kpi('Counters open', `${o.open_counters}/${o.total_counters}`, `${o.staff} staff`)}
        ${kpi('Avg rating (30 days)', o.avg_rating_30d ?? '-', stars(o.avg_rating_30d))}
        ${kpi('Registered customers', fmtNum(o.customers), `${o.active_centers} active centers`)}
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Live status by center</h2><div class="hint">Refreshes every 10 seconds</div></div>
          <a class="btn btn-sm" href="#/analytics">Peak-hour analytics${icon('chevronRight', { size: 14 })}</a></div>
        <div class="card-body flush">${table([
          { label: 'Center', render: (c) => html`<div class="row" style="flex-wrap:nowrap">${appIcon(c.category, 32)}<div><b>${c.name}</b><div class="muted small">${c.location}</div></div></div>` },
          { label: 'Now', render: (c) => (c.is_open_now ? html`<span class="badge open">Open</span>` : html`<span class="badge closed">Closed</span>`) },
          { label: 'Waiting', num: true, key: 'waiting_count' },
          { label: 'Served today', num: true, key: 'served_today' },
          { label: 'Counters', num: true, render: (c) => `${c.open_counters}/${c.total_counters}` },
          { label: 'Shortest wait', num: true, render: (c) => minutesLabel(c.min_wait_minutes) },
          { label: 'Rating', num: true, render: (c) => (c.avg_rating ? html`${c.avg_rating} ${stars(c.avg_rating, 11)}` : '-') },
          { label: '', render: (c) => html`<a class="btn btn-sm" href="#/centers/${c.center_id}">Configure</a>` },
        ], o.centers)}</div>
      </div>`);
  };
  await load();
  ctx.poll(load, OVERVIEW_POLL_MS);
}

// ------------------------------------------------------------------ analytics
export async function analyticsView(ctx) {
  ctx.setTitle('Peak-hour analytics', 'When do queues form, how long do people wait, and how satisfied are they?');
  const centers = await api.get('/api/admin/centers');
  const filters = { centerId: '', days: 30 };

  const draw = async () => {
    const a = await api.get('/api/admin/analytics', filters);
    if (!ctx.isCurrent()) return;
    const totalRatings = a.ratings.reduce((s, r) => s + r.count, 0);
    render(ctx.el, html`
      <div class="card"><div class="card-body row">
        <div class="field" style="min-width:220px"><label for="f-center">Service center</label>
          <select class="input" id="f-center">
            <option value="">All centers</option>
            ${centers.map((c) => html`<option value="${c.center_id}" ${String(c.center_id) === filters.centerId ? 'selected' : ''}>${c.name}</option>`)}
          </select></div>
        <div class="field"><label>Period</label>
          <div class="seg">${[7, 14, 30].map((d) => html`<button class="${filters.days === d ? 'on' : ''}" data-days="${d}">${d} days</button>`)}</div></div>
      </div></div>

      <div class="card">
        <div class="card-head"><div><h2>Peak-hour heatmap</h2><div class="hint">Tokens issued by weekday and hour — see the scale below</div></div></div>
        <div class="card-body">${heatmap(a.heatmap)}</div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><div><h2>Average tokens per hour</h2><div class="hint">Typical day profile</div></div></div>
          <div class="card-body">${barChart(a.hourly.map((h) => ({
            label: String(h.hour).padStart(2, '0'), value: h.avg_tokens,
            tip: `${hourLabel(h.hour)}–${hourLabel(h.hour + 1)}\n${h.avg_tokens} tokens/day on average`,
          })))}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Average wait by hour (minutes)</h2><div class="hint">Time from joining to being called</div></div></div>
          <div class="card-body">${barChart(a.hourly.map((h) => ({
            label: String(h.hour).padStart(2, '0'), value: h.avg_wait_minutes,
            tip: `${hourLabel(h.hour)}–${hourLabel(h.hour + 1)}\n${h.avg_wait_minutes ?? '-'} min average wait`,
          })))}</div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><div><h2>Daily volume</h2><div class="hint">Tokens per day</div></div></div>
          <div class="card-body">${barChart(a.daily.map((d) => ({
            label: d.day.slice(8), value: d.tokens,
            tip: `${d.day}\n${d.tokens} tokens · ${d.completed} served · ${d.no_show} no-shows\navg wait ${d.avg_wait_minutes ?? '-'} min`,
          })), { labelEvery: a.daily.length > 16 ? 3 : 1 })}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Rating distribution</h2><div class="hint">${totalRatings} ratings in this period</div></div></div>
          <div class="card-body">${hbars(a.ratings.map((r) => ({
            label: `${r.rating} star${r.rating > 1 ? 's' : ''}`, value: r.count,
            tip: `${r.count} ratings (${totalRatings ? Math.round((100 * r.count) / totalRatings) : 0}%)`,
          })), { format: (v) => fmtNum(v) })}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Service breakdown</h2><div class="hint">Table view of the period</div></div></div>
        <div class="card-body flush">${table([
          { label: 'Center', key: 'center' },
          { label: 'Service', render: (s) => html`<b>${s.service}</b>` },
          { label: 'Tokens', num: true, key: 'tokens' },
          { label: 'Served', num: true, key: 'completed' },
          { label: 'Avg wait', num: true, render: (s) => (s.avg_wait_minutes === null ? '-' : `${s.avg_wait_minutes} min`) },
          { label: 'Avg service', num: true, render: (s) => (s.avg_service_minutes === null ? '-' : `${s.avg_service_minutes} min`) },
          { label: 'Rating', num: true, render: (s) => s.avg_rating ?? '-' },
        ], a.services)}</div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Staff performance</h2></div></div>
        <div class="card-body flush">${table([
          { label: 'Staff', render: (s) => html`<b>${s.staff}</b>` },
          { label: 'Center', key: 'center' },
          { label: 'Counter', key: 'counter' },
          { label: 'Served', num: true, key: 'served' },
          { label: 'Avg service', num: true, render: (s) => (s.avg_service_minutes === null ? '-' : `${s.avg_service_minutes} min`) },
          { label: 'Avg rating', num: true, render: (s) => s.avg_rating ?? '-' },
        ], a.staff)}</div>
      </div>`);

    ctx.el.querySelector('#f-center').addEventListener('change', (e) => { filters.centerId = e.target.value; draw(); });
    ctx.el.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => { filters.days = Number(b.dataset.days); draw(); }));
  };
  await draw();
}

// ------------------------------------------------------------------ queues
export async function queuesView(ctx) {
  ctx.setTitle('Queues', 'One queue per service per day');
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let date = iso(today);

  const load = async () => {
    const rows = await api.get('/api/admin/queues', { date });
    if (!ctx.isCurrent()) return;
    if (document.querySelector('.modal-backdrop')) return;
    const isToday = date === iso(today);
    render(ctx.el, html`
      <div class="card">
        <div class="card-head">
          <div><h2>Queues on ${date}</h2><div class="hint">${rows.length} queues · ${rows.reduce((s, r) => s + r.issued, 0)} tokens issued</div></div>
          <input type="date" class="input" style="width:auto" id="q-date" value="${date}" max="${iso(today)}">
        </div>
        <div class="card-body flush">${table([
          { label: 'Center', key: 'center_name' },
          { label: 'Service', render: (q) => html`<b>${q.service_name}</b> <span class="tag">${q.code}</span>` },
          { label: 'Status', render: (q) => statusBadge(q.status) },
          { label: 'Issued', num: true, key: 'issued' },
          { label: 'Waiting', num: true, key: 'waiting' },
          { label: 'At counter', num: true, key: 'at_counter' },
          { label: 'Completed', num: true, key: 'completed' },
          { label: 'Dropped', num: true, render: (q) => html`<span data-tip="cancelled + no-show">${q.dropped}</span>` },
          { label: 'Opened', render: (q) => fmtDateTime(q.opened_at) },
          { label: '', render: (q) => (isToday ? queueActions(q) : (q.closed_at ? html`<span class="muted small">closed ${fmtDateTime(q.closed_at)}</span>` : '')) },
        ], rows, { empty: 'No queues on this date' })}</div>
      </div>`);
    ctx.el.querySelector('#q-date').addEventListener('change', (e) => { if (e.target.value) { date = e.target.value; load(); } });
    ctx.el.querySelectorAll('[data-queue]').forEach((b) => b.addEventListener('click', async () => {
      const status = b.dataset.status;
      if (status === 'closed' && !(await confirmDialog({
        title: 'Close this queue?',
        message: 'All tokens still waiting or skipped are cancelled in the same transaction and their owners are notified.',
        confirmLabel: 'Close queue',
        danger: true,
      }))) return;
      await withBusy(b, async () => {
        await api.patch(`/api/admin/queues/${b.dataset.queue}`, { status });
        toast('Queue updated');
        await load();
      });
    }));
  };
  await load();
  ctx.poll(load, OVERVIEW_POLL_MS);
}

function queueActions(q) {
  const b = (status, label, cls = '') => html`<button class="btn btn-sm ${cls}" data-queue="${q.queue_id}" data-status="${status}">${label}</button>`;
  if (q.status === 'open') return html`<div class="row" style="gap:6px;flex-wrap:nowrap">${b('paused', 'Pause')}${b('closed', 'Close', 'btn-danger')}</div>`;
  if (q.status === 'paused') return html`<div class="row" style="gap:6px;flex-wrap:nowrap">${b('open', 'Resume')}${b('closed', 'Close', 'btn-danger')}</div>`;
  return b('open', 'Re-open');
}

// ------------------------------------------------------------------ feedback
export async function feedbackView(ctx) {
  ctx.setTitle('Customer feedback', 'Ratings submitted after a token was served');
  const centers = await api.get('/api/admin/centers');
  const filters = { centerId: '', maxRating: '' };
  const load = async () => {
    const rows = await api.get('/api/admin/feedback', filters);
    if (!ctx.isCurrent()) return;
    render(ctx.el, html`
      <div class="card"><div class="card-body row">
        <div class="field" style="min-width:220px"><label for="fb-center">Center</label>
          <select class="input" id="fb-center"><option value="">All centers</option>
            ${centers.map((c) => html`<option value="${c.center_id}" ${String(c.center_id) === filters.centerId ? 'selected' : ''}>${c.name}</option>`)}</select></div>
        <div class="field" style="min-width:180px"><label for="fb-rating">Rating</label>
          <select class="input" id="fb-rating">
            <option value="">Any rating</option>
            ${[2, 3].map((r) => html`<option value="${r}" ${String(r) === filters.maxRating ? 'selected' : ''}>${r} stars or lower</option>`)}
          </select></div>
      </div></div>
      <div class="card"><div class="card-head"><h2>Latest feedback</h2><span class="muted small">${rows.length} shown</span></div>
        <div class="card-body flush">${table([
          { label: 'Rating', render: (f) => stars(f.rating) },
          { label: 'Comment', render: (f) => f.comment || html`<span class="muted">No comment</span>` },
          { label: 'Token', render: (f) => html`<span class="token-code">${f.token_code}</span>` },
          { label: 'Customer', key: 'customer_name' },
          { label: 'Center / service', render: (f) => html`${f.center_name}<div class="muted small">${f.service_name}</div>` },
          { label: 'Served by', render: (f) => f.served_by || '-' },
          { label: 'When', render: (f) => fmtDateTime(f.submitted_at) },
        ], rows, { empty: 'No feedback matches these filters' })}</div></div>`);
    ctx.el.querySelector('#fb-center').addEventListener('change', (e) => { filters.centerId = e.target.value; load(); });
    ctx.el.querySelector('#fb-rating').addEventListener('change', (e) => { filters.maxRating = e.target.value; load(); });
  };
  await load();
}
