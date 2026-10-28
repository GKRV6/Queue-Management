import { icon } from './icons.js';

// Rendering helpers. Every interpolated value passes through esc() unless it
// is explicitly wrapped in raw(), so user-supplied text can never inject HTML.

class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
export const raw = (value) => new Raw(String(value));

export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtVal(v) {
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(fmtVal).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

/** Tagged template that escapes interpolations: html`<b>${name}</b>` */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < values.length ? fmtVal(values[i]) : ''); });
  return raw(out);
}

export function render(el, content) {
  el.innerHTML = fmtVal(content);
}

// ------------------------------------------------------------- formatting
export const parseTs = (ts) => (ts ? new Date(String(ts).replace(' ', 'T')) : null);

export function fmtTime(ts) {
  const d = parseTs(ts);
  return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
}

export function fmtDateTime(ts) {
  const d = parseTs(ts);
  if (!d) return '-';
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(ts) {
  const d = parseTs(ts);
  return d ? d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '-';
}

export function timeAgo(ts) {
  const d = parseTs(ts);
  if (!d) return '-';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return fmtDateTime(ts);
}

export function minutesLabel(n) {
  if (n === null || n === undefined) return '-';
  const m = Math.max(0, Math.round(n));
  if (m === 0) return 'now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const fmtNum = (n, digits = 0) =>
  n === null || n === undefined ? '-' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });

const STATUS_LABELS = {
  waiting: 'Waiting', called: 'Called', serving: 'Serving', completed: 'Completed', skipped: 'Skipped',
  cancelled: 'Cancelled', no_show: 'No-show', open: 'Open', paused: 'Paused', closed: 'Closed', not_started: 'Not started',
};
export const statusLabel = (s) => STATUS_LABELS[s] || s;
export const statusBadge = (s) => html`<span class="badge ${s}">${statusLabel(s)}</span>`;

export function stars(rating, size = 14) {
  if (!rating) return html`<span class="muted">-</span>`;
  const r = Math.round(rating);
  return html`<span class="stars" role="img" aria-label="${rating} out of 5">${[1, 2, 3, 4, 5].map((n) =>
    html`<span class="${n <= r ? '' : 'off'}">${icon('starFill', { size })}</span>`)}</span>`;
}

export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

// ------------------------------------------------------------- feedback UI
export function toast(message, type = 'info') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const glyph = { success: 'check', error: 'alert', info: 'bell' }[type] || 'bell';
  render(el, html`<span class="t-icon">${icon(glyph, { size: 17 })}</span><span></span>`);
  el.lastChild.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 5200 : 3200);
}

/**
 * Opens a modal containing a form. onSubmit(values) may throw; its message is
 * shown inside the modal. Resolves with onSubmit's result, or null if dismissed.
 */
export function openModal({ title, subtitle, body, submitLabel = 'Save', danger = false, onSubmit, onMount, wide = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    render(backdrop, html`
      <form class="modal" role="dialog" aria-modal="true" aria-label="${title}" style="${wide ? 'width:min(760px,100%)' : ''}" novalidate>
        <div class="modal-head">
          <div><h2>${title}</h2>${subtitle ? html`<p class="muted small" style="margin-top:4px">${subtitle}</p>` : ''}</div>
          <button type="button" class="close-btn" data-close aria-label="Close">${icon('xmark', { size: 15 })}</button>
        </div>
        <div class="modal-body">${body}<p class="error-text" data-error hidden></p></div>
        <div class="modal-foot">
          <button type="button" class="btn btn-plain" data-close>Cancel</button>
          ${onSubmit ? html`<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>` : ''}
        </div>
      </form>`);
    const form = backdrop.querySelector('form');
    const errorEl = backdrop.querySelector('[data-error]');
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
    backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close(null);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      errorEl.hidden = true;
      try {
        close(await onSubmit(formValues(form), form));
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        btn.disabled = false;
      }
    });
    document.body.appendChild(backdrop);
    if (onMount) onMount(form);
    const first = form.querySelector('input:not([type=hidden]), select, textarea');
    (first || form.querySelector('button[type=submit]') || form).focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return openModal({
    title, body: html`<p>${message}</p>`, submitLabel: confirmLabel, danger, onSubmit: () => true,
  }).then(Boolean);
}

/** Reads a form into a plain object; checkboxes sharing a name become arrays. */
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi !== undefined) {
        out[el.name] = out[el.name] || [];
        if (el.checked) out[el.name].push(el.value);
      } else {
        out[el.name] = el.checked;
      }
    } else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else {
      out[el.name] = el.value;
    }
  }
  return out;
}

/** Runs an async action with a button disabled meanwhile; reports errors as toasts. */
export async function withBusy(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

// ------------------------------------------------------------- tooltip
export function initTooltips() {
  const tip = document.getElementById('tooltip');
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) { tip.hidden = true; return; }
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.hidden) return;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = e.clientY - tip.offsetHeight - 12 < 4 ? e.clientY + 18 : e.clientY - tip.offsetHeight - 12;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, true);
}

// ------------------------------------------------------------- tables
/**
 * columns: [{ key, label, num, render(row) }]
 */
export function table(columns, rows, { empty = 'No records yet' } = {}) {
  if (!rows || !rows.length) return emptyState('tray', empty);
  return html`
    <div class="table-wrap"><table>
      <thead><tr>${columns.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${columns.map((c) => html`<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : r[c.key] ?? '-'}</td>`)}</tr>`)}</tbody>
    </table></div>`;
}

export const emptyState = (iconName, text, extra = '') =>
  html`<div class="empty"><span class="e-icon">${icon(iconName, { size: 24 })}</span><div>${text}</div>${extra}</div>`;
