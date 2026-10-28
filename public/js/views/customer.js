import { api } from '../api.js';
import {
  html, render, toast, openModal, confirmDialog, withBusy, statusBadge, minutesLabel, fmtTime, fmtDate,
  fmtDateTime, stars, table, emptyState, fmtNum,
} from '../ui.js';
import { icon, appIcon } from '../icons.js';

const TOKEN_POLL_MS = 5000;
const CENTER_POLL_MS = 8000;

// ------------------------------------------------------------------ shared pieces
export function centerCard(c) {
  const open = c.is_open_now ? html`<span class="badge open">Open now</span>` : html`<span class="badge closed">Closed now</span>`;
  return html`
    <a class="card widget" href="#/centers/${c.center_id}">
      <div class="top">
        ${appIcon(c.category, 46)}
        <div style="flex:1;min-width:0">
          <h3>${c.name}</h3>
          <div class="muted small">${c.location} · ${c.opening_time}–${c.closing_time}</div>
          <div style="margin-top:7px">${open}</div>
        </div>
        <span class="muted">${icon('chevronRight', { size: 16 })}</span>
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${c.waiting_count}</div><div class="k">waiting</div></div>
        <div class="stat"><div class="v">${c.min_wait_minutes === null ? '-' : `${Math.round(c.min_wait_minutes)}m`}</div><div class="k">shortest wait</div></div>
        <div class="stat"><div class="v">${c.open_counters}/${c.total_counters}</div><div class="k">counters open</div></div>
      </div>
    </a>`;
}

const PASS_STATUS = { waiting: 'In line', called: 'Your turn', serving: 'Being served', skipped: 'Skipped' };

/** A token rendered as an Apple Wallet style pass. */
function ticket(t) {
  const isWaiting = t.status === 'waiting';
  let message = '';
  if (t.status === 'called') message = html`<div class="pass-msg">${icon('megaphone', { size: 18 })}<span>Please go to <b>${t.counter_label}</b> now.</span></div>`;
  if (t.status === 'serving') message = html`<div class="pass-msg">${icon('checkCircle', { size: 18 })}<span>You are being served at ${t.counter_label}.</span></div>`;
  if (t.status === 'skipped') message = html`<div class="pass-msg">${icon('alert', { size: 18 })}<span>You were skipped. Reach ${t.center_name} and ask staff to re-queue your token.</span></div>`;
  if (isWaiting && !t.is_eligible) {
    message = html`<div class="pass-msg">${icon('calendar', { size: 18 })}<span>Booked for ${t.slot_start}–${t.slot_end}. You join the live line at ${t.slot_start}.</span></div>`;
  }
  const field = (k, v) => html`<div class="pass-field"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  return html`
    <div class="pass ${t.status}">
      <div class="pass-inner">
        <div class="pass-top">
          <div class="pass-org">${appIcon(t.category, 34)}<div><div>${t.center_name}</div><div class="small" style="opacity:.8;font-weight:500">${t.location}</div></div></div>
          <div class="row" style="gap:6px">${t.priority === 'priority' ? html`<span class="pass-status">Priority</span>` : ''}<span class="pass-status ${t.status}">${PASS_STATUS[t.status] || t.status}</span></div>
        </div>
        <div>
          <div class="pass-field"><div class="k">${t.service_name}</div></div>
          <div class="pass-code">${t.token_code}</div>
        </div>
        ${isWaiting && t.position ? html`
          <div class="pass-fields">
            ${field('Position', `#${t.position}`)}
            ${field('Ahead of you', t.position - 1)}
            ${field('Est. wait', t.est_wait_minutes === null ? 'No counter open' : minutesLabel(t.est_wait_minutes))}
            ${field('Issued', fmtTime(t.issued_at))}
          </div>` : html`<div class="pass-fields">${field('Issued', fmtTime(t.issued_at))}${t.counter_label ? field('Counter', t.counter_label) : ''}</div>`}
      </div>
      <div class="pass-foot">
        ${message}
        ${['waiting', 'called', 'skipped'].includes(t.status) ? html`<button class="btn btn-sm" data-cancel="${t.token_id}" data-code="${t.token_code}">Cancel token</button>` : ''}
        <button class="btn btn-sm" data-timeline="${t.token_id}" data-code="${t.token_code}">${icon('clock', { size: 15 })}Timeline</button>
        ${t.notes ? html`<span class="small" style="opacity:.85">Note: ${t.notes}</span>` : ''}
      </div>
    </div>`;
}

async function showTimeline(tokenId, code) {
  const rows = await api.get(`/api/tokens/${tokenId}/timeline`);
  await openModal({
    title: `Timeline of ${code}`,
    subtitle: 'Every status change is recorded by a database trigger.',
    body: html`<ul class="timeline">${rows.map((r) => html`
      <li><b>${r.to_status.replace('_', '-')}</b><span class="muted">${fmtDateTime(r.changed_at)} · by ${r.changed_by}</span></li>`)}</ul>`,
  });
}

function bindTokenActions(el, reload, ctx) {
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Cancel token ${b.dataset.code}?`,
      message: 'You will lose your place in the queue. This cannot be undone.',
      confirmLabel: 'Cancel token',
      danger: true,
    });
    if (!ok) return;
    await withBusy(b, async () => {
      await api.post(`/api/tokens/${b.dataset.cancel}/cancel`);
      toast('Token cancelled');
      await reload();
      ctx.refreshNotifications();
    });
  }));
  el.querySelectorAll('[data-timeline]').forEach((b) => b.addEventListener('click', () =>
    withBusy(b, () => showTimeline(b.dataset.timeline, b.dataset.code))));
}

// ------------------------------------------------------------------ views
export async function homeView(ctx) {
  ctx.setTitle(`Hi, ${ctx.user.full_name.split(' ')[0]}`, 'Your live tokens update automatically');
  render(ctx.el, html`<div id="tokens"></div><div id="centers"></div>`);
  const tokensEl = ctx.el.querySelector('#tokens');
  const centersEl = ctx.el.querySelector('#centers');

  const loadTokens = async () => {
    const tokens = await api.get('/api/tokens/active');
    if (!ctx.isCurrent()) return;
    render(tokensEl, html`
      <div class="stack">
        <div class="row between"><div class="section-title">Your passes</div><span class="muted small">Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
        ${tokens.length ? html`<div class="grid grid-2">${tokens.map(ticket)}</div>` : html`<div class="card">${emptyState('ticket', "You're not in any queue right now.", html`<a class="btn btn-primary" href="#/centers">Join a queue</a>`)}</div>`}
      </div>`);
    bindTokenActions(tokensEl, loadTokens, ctx);
  };
  const loadCenters = async () => {
    const centers = await api.get('/api/centers');
    if (!ctx.isCurrent()) return;
    render(centersEl, html`
      <div class="stack" style="margin-top:8px"><div class="section-title">Service centers</div><div class="grid grid-auto">${centers.map(centerCard)}</div></div>`);
  };

  await Promise.all([loadTokens(), loadCenters()]);
  ctx.poll(loadTokens, TOKEN_POLL_MS);
  ctx.poll(loadCenters, CENTER_POLL_MS * 2);
}

export async function centersView(ctx) {
  ctx.setTitle('Service centers', 'Live queue length and waiting time at every center');
  const load = async () => {
    const centers = await api.get('/api/centers');
    if (!ctx.isCurrent()) return;
    render(ctx.el, html`<div class="grid grid-auto">${centers.map(centerCard)}</div>`);
  };
  await load();
  ctx.poll(load, CENTER_POLL_MS);
}

function serviceRow(s, canJoin) {
  const joinable = canJoin && s.queue_status !== 'paused' && s.queue_status !== 'closed';
  return html`
    <div class="service-row">
      <div>
        <div class="row"><b>${s.name}</b><span class="tag">${s.code}</span>
          ${s.queue_status !== 'open' ? statusBadge(s.queue_status) : ''}</div>
        <div class="muted small">${s.description || ''}${s.fee ? ` · ₹${s.fee}` : ''}</div>
      </div>
      <div class="metric"><div class="v">${s.waiting_count}</div><div class="k">waiting</div></div>
      <div class="metric hide-sm"><div class="v">${s.open_counters}</div><div class="k">open counters</div></div>
      <div class="row" style="gap:14px">
        <div class="metric"><div class="v">${s.est_wait_minutes === null ? 'Paused' : `~${minutesLabel(s.est_wait_minutes)}`}</div><div class="k">${s.est_wait_minutes === null ? 'no counter open' : 'est. wait'}</div></div>
        ${canJoin ? html`<button class="btn btn-primary" data-join="${s.service_type_id}" ${joinable ? '' : 'disabled'}
            data-tip="${joinable ? `Avg ${s.est_service_minutes} min per person` : 'This queue is not accepting tokens right now'}">Join queue</button>` : ''}
      </div>
    </div>`;
}

async function joinFlow(center, service, ctx) {
  const slots = center.slots;
  const result = await openModal({
    title: `Join ${service.name}`,
    subtitle: `${center.name} · ${service.waiting_count} waiting · about ${minutesLabel(service.est_wait_minutes)} if you join now`,
    submitLabel: 'Get my token',
    body: html`
      <div class="field">
        <label>When do you want to be served?</label>
        <div class="slot-grid">
          <button type="button" class="slot on" data-slot=""><div class="t">Join now</div><div class="r">Live queue</div></button>
          ${slots.map((s) => html`
            <button type="button" class="slot" data-slot="${s.slot_id}" ${s.bookable && s.remaining > 0 ? '' : 'disabled'}>
              <div class="t">${s.start_time}–${s.end_time}</div>
              <div class="r">${!s.bookable ? 'Ended' : s.remaining > 0 ? `${s.remaining} of ${s.max_tokens} left` : 'Full'}</div>
            </button>`)}
        </div>
        ${slots.length ? html`<span class="help">A booked slot keeps your token on hold until the slot starts.</span>` : ''}
      </div>
      <input type="hidden" name="slotId" value="">
      <div class="field"><label for="notes">Note for staff (optional)</label>
        <input class="input" id="notes" name="notes" maxlength="200" placeholder="Anything the staff should know"></div>`,
    onMount(form) {
      form.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
        form.querySelectorAll('[data-slot]').forEach((x) => x.classList.toggle('on', x === b));
        form.elements.slotId.value = b.dataset.slot;
      }));
    },
    onSubmit: (v) => api.post('/api/tokens', {
      serviceTypeId: service.service_type_id,
      slotId: v.slotId ? Number(v.slotId) : undefined,
      notes: v.notes || undefined,
    }),
  });
  if (result) {
    toast(`Token ${result.token_code} issued — you are #${result.position ?? '-'} in line`, 'success');
    ctx.refreshNotifications();
    window.location.hash = '#/';
  }
}

export async function centerDetailView(ctx) {
  const id = Number(ctx.params[0]);
  const canJoin = ctx.user.role === 'customer';
  let center;
  const load = async () => {
    center = await api.get(`/api/centers/${id}`);
    if (!ctx.isCurrent()) return;
    ctx.setTitle(center.name, `${center.location} · open ${center.opening_time}–${center.closing_time}`);
    render(ctx.el, html`
      <div><a href="#/centers" class="btn btn-sm">${icon('chevronLeft', { size: 15 })}All centers</a></div>
      <div class="kpis">
        <div class="card kpi"><div class="label">Waiting now</div><div class="value">${center.waiting_count}</div></div>
        <div class="card kpi"><div class="label">Served today</div><div class="value">${center.served_today}</div></div>
        <div class="card kpi"><div class="label">Counters open</div><div class="value">${center.open_counters}/${center.total_counters}</div></div>
        <div class="card kpi"><div class="label">Rating (30 days)</div><div class="value">${center.avg_rating ?? '-'}</div><div class="foot">${stars(center.avg_rating)}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Services</h2><div class="hint">${center.description || ''}</div></div>
          ${center.is_open_now ? html`<span class="badge open">Open now</span>` : html`<span class="badge closed">Outside opening hours</span>`}</div>
        <div class="card-body flush">${center.services.map((s) => serviceRow(s, canJoin))}</div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Now serving</h2><div class="hint">Live display board</div></div></div>
        <div class="card-body"><div class="board">
          ${center.counters.map((c) => html`
            <div class="board-tile">
              <div class="row between"><b>${c.label}</b>${statusBadge(c.status)}</div>
              <div class="now">${c.current_token || '—'}</div>
              <div class="muted small">${c.current_token ? (c.current_status === 'called' ? 'Calling…' : 'Being served') : 'Idle'} · ${c.services || ''}</div>
            </div>`)}
        </div></div>
      </div>`);
    ctx.el.querySelectorAll('[data-join]').forEach((b) => b.addEventListener('click', () => {
      const service = center.services.find((s) => s.service_type_id === Number(b.dataset.join));
      joinFlow(center, service, ctx);
    }));
  };
  await load();
  ctx.poll(load, CENTER_POLL_MS);
}

export async function historyView(ctx) {
  ctx.setTitle('History & feedback', 'Past visits, waiting times and your ratings');
  const load = async () => {
    const rows = await api.get('/api/tokens/history');
    if (!ctx.isCurrent()) return;
    const served = rows.filter((r) => r.status === 'completed');
    const avgWait = served.length ? served.reduce((s, r) => s + (r.wait_minutes || 0), 0) / served.length : null;
    const pending = served.filter((r) => !r.rating).length;
    render(ctx.el, html`
      <div class="kpis">
        <div class="card kpi"><div class="label">Visits</div><div class="value">${rows.length}</div></div>
        <div class="card kpi"><div class="label">Served</div><div class="value">${served.length}</div></div>
        <div class="card kpi"><div class="label">Average wait</div><div class="value">${avgWait === null ? '-' : minutesLabel(avgWait)}</div><div class="foot">time not spent standing</div></div>
        <div class="card kpi"><div class="label">Awaiting your rating</div><div class="value">${pending}</div></div>
      </div>
      <div class="card"><div class="card-head"><h2>Recent visits</h2></div>
        <div class="card-body flush">${table([
          { label: 'Token', render: (r) => html`<span class="token-code">${r.token_code}</span>` },
          { label: 'Center / service', render: (r) => html`<div>${r.center_name}</div><div class="muted small">${r.service_name}</div>` },
          { label: 'Date', render: (r) => html`${fmtDate(r.issued_at)}<div class="muted small">${fmtTime(r.issued_at)}</div>` },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'Waited', num: true, render: (r) => (r.wait_minutes === null ? '-' : `${fmtNum(r.wait_minutes, 1)} min`) },
          { label: 'Service', num: true, render: (r) => (r.service_minutes === null ? '-' : `${fmtNum(r.service_minutes, 1)} min`) },
          {
            label: 'Your rating',
            render: (r) => (r.rating
              ? html`<span data-tip="${r.feedback_comment || 'No comment'}">${stars(r.rating)}</span>`
              : r.status === 'completed'
                ? html`<button class="btn btn-sm btn-primary" data-rate="${r.token_id}" data-code="${r.token_code}">Rate visit</button>`
                : html`<span class="muted">-</span>`),
          },
        ], rows, { empty: 'No past visits yet' })}</div></div>`);
    ctx.el.querySelectorAll('[data-rate]').forEach((b) => b.addEventListener('click', async () => {
      if (await rateVisit(b.dataset.rate, b.dataset.code)) await load();
    }));
  };
  await load();
}

function rateVisit(tokenId, code) {
  return openModal({
    title: `Rate your visit (${code})`,
    submitLabel: 'Submit feedback',
    body: html`
      <div class="field"><label>How was the service?</label>
        <div class="star-input" role="radiogroup">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" data-star="${n}" aria-label="${n} stars">${icon('starFill', { size: 34 })}</button>`)}</div>
        <input type="hidden" name="rating" value=""></div>
      <div class="field"><label for="comment">Comment (optional)</label>
        <textarea class="input" id="comment" name="comment" maxlength="500" placeholder="What went well? What could be better?"></textarea></div>`,
    onMount(form) {
      const btns = form.querySelectorAll('[data-star]');
      btns.forEach((b) => b.addEventListener('click', () => {
        form.elements.rating.value = b.dataset.star;
        btns.forEach((x) => x.classList.toggle('on', Number(x.dataset.star) <= Number(b.dataset.star)));
      }));
    },
    onSubmit: async (v) => {
      if (!v.rating) throw new Error('Please choose a star rating');
      await api.post(`/api/tokens/${tokenId}/feedback`, { rating: Number(v.rating), comment: v.comment || undefined });
      toast('Thanks for your feedback!', 'success');
      return true;
    },
  });
}

