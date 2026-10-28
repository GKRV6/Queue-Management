import { api } from '../api.js';
import {
  html, render, toast, openModal, confirmDialog, withBusy, statusBadge, minutesLabel, fmtTime, timeAgo, table, emptyState, stars,
} from '../ui.js';
import { icon } from '../icons.js';

const CONSOLE_POLL_MS = 4000;

function elapsed(ts) {
  return timeAgo(ts).replace(' ago', '');
}

function nowServingCard(d) {
  const counterOpen = d.staff.counter_status === 'open';
  const t = d.current;
  if (!d.staff.counter_id) {
    return html`<div class="card">${emptyState('chair', 'You are not assigned to a counter yet. Ask an administrator to assign one.')}</div>`;
  }
  if (!t) {
    return html`
      <div class="card"><div class="empty-call">
        <span class="ring">${icon('megaphone', { size: 28 })}</span>
        <div><h2>Ready for the next customer</h2><div class="muted" style="margin-top:4px">No token at your counter</div></div>
        <button class="btn btn-primary btn-lg" data-act="call-next" ${counterOpen ? '' : 'disabled'}>Call Next Token</button>
        <div class="small muted">${counterOpen
          ? `${d.waiting.filter((w) => w.is_eligible).length} eligible tokens waiting for this counter`
          : 'Open your counter to start calling tokens'}</div>
      </div></div>`;
  }
  const lastChange = t.updated_at;
  return html`
    <div class="card now-serving">
      <div>
        <div class="row">${statusBadge(t.status)}${t.priority === 'priority' ? html`<span class="badge priority">Priority</span>` : ''}
          <span class="muted small">${t.status === 'called' ? 'called' : 'serving for'} ${elapsed(lastChange)}</span></div>
        <div class="code" style="margin-top:10px">${t.token_code}</div>
        <div class="who">${t.customer_name}</div>
        <div class="muted">${t.service_name}${t.slot_start ? ` · slot ${t.slot_start}–${t.slot_end}` : ''}${t.notes ? ` · “${t.notes}”` : ''}</div>
      </div>
      <div class="actions">
        ${t.status === 'called' ? html`
          <button class="btn btn-good btn-lg" data-act="start" data-id="${t.token_id}">${icon('play', { size: 16 })}Start Serving</button>
          <button class="btn" data-act="skip" data-id="${t.token_id}">Not here — Skip</button>
          <button class="btn btn-danger" data-act="no-show" data-id="${t.token_id}" data-code="${t.token_code}">Mark No-show</button>` : html`
          <button class="btn btn-good btn-lg" data-act="complete" data-id="${t.token_id}" data-code="${t.token_code}">${icon('check', { size: 17 })}Complete Service</button>`}
      </div>
    </div>`;
}

function counterControls(d) {
  if (!d.staff.counter_id) return '';
  return html`
    <div class="seg" role="group" aria-label="Counter status">
      ${['open', 'paused', 'closed'].map((s) => html`<button class="${d.staff.counter_status === s ? 'on' : ''}" data-counter="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`)}
    </div>`;
}

function renderConsole(ctx, d) {
  const s = d.staff;
  ctx.setTitle(s.counter_label ? `${s.counter_label}` : 'Counter console', `${s.center_name} · ${s.designation}`);
  render(ctx.el, html`
    <div class="row between">
      <div class="row">${d.services.map((x) => html`<span class="tag">${x.code} · ${x.name}</span>`)}</div>
      ${counterControls(d)}
    </div>
    ${nowServingCard(d)}
    <div class="kpis">
      <div class="card kpi"><div class="label">Served by you today</div><div class="value">${d.stats.served_today}</div></div>
      <div class="card kpi"><div class="label">Your avg service time</div><div class="value">${d.stats.avg_service_minutes === null ? '-' : `${d.stats.avg_service_minutes} min`}</div></div>
      <div class="card kpi"><div class="label">Your rating today</div><div class="value">${d.stats.avg_rating_today ?? '-'}</div><div class="foot">${stars(d.stats.avg_rating_today)}</div></div>
      <div class="card kpi"><div class="label">Waiting for this counter</div><div class="value">${d.waiting.length}</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div><h2>Waiting line</h2><div class="hint">In the order they will be called</div></div></div>
        <div class="card-body flush">${table([
          { label: '#', render: (w) => (w.is_eligible ? w.position : html`<span class="muted" data-tip="Booked slot starts ${w.slot_start}">${icon('calendar', { size: 15 })}</span>`) },
          { label: 'Token', render: (w) => html`<span class="token-code">${w.token_code}</span>${w.priority === 'priority' ? html` <span class="badge priority plain">P</span>` : ''}` },
          { label: 'Customer', render: (w) => html`${w.customer_name}<div class="muted small">${w.service_name}</div>` },
          { label: 'Waiting', render: (w) => (w.is_eligible ? elapsed(w.eligible_at) : `from ${w.slot_start}`) },
          { label: '', render: (w) => (w.priority === 'priority' ? '' : html`<button class="btn btn-sm btn-ghost" data-act="prioritize" data-id="${w.token_id}" data-tip="Move to the front (e.g. emergency, accessibility)">${icon('arrowUp', { size: 14 })}Priority</button>`) },
        ], d.waiting, { empty: 'Nobody is waiting.' })}</div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h2>Skipped today</h2><div class="hint">Re-queue customers who turn up late</div></div></div>
          <div class="card-body flush">${table([
            { label: 'Token', render: (k) => html`<span class="token-code">${k.token_code}</span>` },
            { label: 'Customer', key: 'customer_name' },
            { label: 'Skipped', render: (k) => timeAgo(k.updated_at) },
            { label: '', render: (k) => html`<div class="row" style="gap:6px;flex-wrap:nowrap">
                <button class="btn btn-sm" data-act="requeue" data-id="${k.token_id}">Re-queue</button>
                <button class="btn btn-sm btn-danger" data-act="no-show" data-id="${k.token_id}" data-code="${k.token_code}">No-show</button></div>` },
          ], d.skipped, { empty: 'No skipped tokens' })}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Queues at ${s.center_name}</h2><div class="hint">Pause stops new tokens; close cancels everyone still waiting</div></div></div>
          <div class="card-body flush">${table([
            { label: 'Service', render: (q) => html`<b>${q.name}</b> <span class="tag">${q.code}</span>` },
            { label: 'Status', render: (q) => statusBadge(q.queue_status) },
            { label: 'Waiting', num: true, key: 'waiting_count' },
            { label: 'Est. wait', num: true, render: (q) => minutesLabel(q.est_wait_minutes) },
            { label: '', render: (q) => (q.queue_id ? queueButtons(q) : html`<span class="muted small">no tokens yet</span>`) },
          ], d.queues)}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Served by you today</h2></div>
      <div class="card-body flush">${table([
        { label: 'Token', render: (r) => html`<span class="token-code">${r.token_code}</span>` },
        { label: 'Customer', key: 'customer_name' },
        { label: 'Service', key: 'service_name' },
        { label: 'Finished', render: (r) => fmtTime(r.ended_at) },
        { label: 'Duration', num: true, render: (r) => `${r.service_minutes} min` },
        { label: 'Remarks', render: (r) => r.remarks || html`<span class="muted">-</span>` },
      ], d.recent, { empty: 'Nothing served yet today' })}</div>
    </div>`);
}

function queueButtons(q) {
  const btn = (status, label, cls = '') => html`<button class="btn btn-sm ${cls}" data-queue="${q.queue_id}" data-status="${status}" data-name="${q.name}">${label}</button>`;
  if (q.queue_status === 'open') return html`<div class="row" style="gap:6px;flex-wrap:nowrap">${btn('paused', 'Pause')}${btn('closed', 'Close', 'btn-danger')}</div>`;
  if (q.queue_status === 'paused') return html`<div class="row" style="gap:6px;flex-wrap:nowrap">${btn('open', 'Resume')}${btn('closed', 'Close', 'btn-danger')}</div>`;
  return btn('open', 'Re-open');
}

async function tokenAction(act, id, code) {
  if (act === 'call-next') {
    const res = await api.post('/api/staff/call-next');
    toast(res.message, res.token ? 'success' : 'info');
    return;
  }
  if (act === 'complete') {
    await openModal({
      title: `Complete ${code}`,
      submitLabel: 'Mark as completed',
      body: html`<div class="field"><label for="remarks">Remarks (optional)</label>
        <input class="input" id="remarks" name="remarks" maxlength="300" placeholder="e.g. 2 copies, paid in cash"></div>`,
      onSubmit: (v) => api.post(`/api/staff/tokens/${id}/complete`, { remarks: v.remarks || undefined }),
    }).then((r) => r && toast(`${code} completed`, 'success'));
    return;
  }
  if (act === 'no-show') {
    const ok = await confirmDialog({ title: `Mark ${code} as no-show?`, message: 'The customer will be notified and the token closed.', confirmLabel: 'Mark no-show', danger: true });
    if (!ok) return;
  }
  await api.post(`/api/staff/tokens/${id}/${act}`);
}

export async function consoleView(ctx) {
  const load = async () => {
    const d = await api.get('/api/staff/dashboard');
    if (!ctx.isCurrent()) return;
    if (document.querySelector('.modal-backdrop')) return; // don't redraw under an open dialog
    renderConsole(ctx, d);
    bind(d);
  };

  const bind = () => {
    ctx.el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () =>
      withBusy(b, async () => {
        await tokenAction(b.dataset.act, b.dataset.id, b.dataset.code);
        await load();
      })));
    ctx.el.querySelectorAll('[data-counter]').forEach((b) => b.addEventListener('click', () =>
      withBusy(b, async () => {
        await api.patch('/api/staff/counter', { status: b.dataset.counter });
        toast(`Counter is now ${b.dataset.counter}`);
        await load();
      })));
    ctx.el.querySelectorAll('[data-queue]').forEach((b) => b.addEventListener('click', async () => {
      const status = b.dataset.status;
      if (status === 'closed') {
        const ok = await confirmDialog({
          title: `Close the ${b.dataset.name} queue?`,
          message: 'Everyone still waiting will have their token cancelled and be notified. Use this at the end of the day.',
          confirmLabel: 'Close queue',
          danger: true,
        });
        if (!ok) return;
      }
      await withBusy(b, async () => {
        await api.patch(`/api/staff/queues/${b.dataset.queue}`, { status });
        toast(`Queue ${status === 'open' ? 'opened' : status}`);
        await load();
      });
    }));
  };

  await load();
  ctx.poll(load, CONSOLE_POLL_MS);
}
