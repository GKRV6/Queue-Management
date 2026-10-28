// Small dependency-free charts rendered as HTML. Single-hue (sequential blue)
// encodings only; every mark carries a hover tooltip via data-tip and every
// chart has a table view elsewhere on the page.
import { html } from './ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SEQ_STEPS = 6;
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

/** Weekday x hour heatmap of token counts. */
export function heatmap(rows) {
  if (!rows.length) return html`<div class="empty">No data for this period</div>`;
  const hours = rows.map((r) => r.hour);
  const minH = Math.min(...hours);
  const maxH = Math.max(...hours);
  const cols = [];
  for (let h = minH; h <= maxH; h += 1) cols.push(h);
  const max = Math.max(...rows.map((r) => r.tokens));
  const lookup = new Map(rows.map((r) => [`${r.dow}-${r.hour}`, r.tokens]));
  const step = (v) => (v ? Math.max(1, Math.ceil((v / max) * SEQ_STEPS)) : 0);

  return html`
    <div class="heatmap" style="--cols:${cols.length}">
      <div></div>${cols.map((h) => html`<div class="hlabel">${h % 2 === 0 ? String(h).padStart(2, '0') : ''}</div>`)}
      ${DAY_ORDER.map((d) => html`
        <div class="vlabel">${DAYS[d]}</div>
        ${cols.map((h) => {
          const v = lookup.get(`${d}-${h}`) || 0;
          return html`<div class="cell" style="background:var(--seq-${step(v)})" data-tip="${DAYS[d]} ${hourLabel(h)}–${hourLabel(h + 1)}\n${v} tokens issued"></div>`;
        })}`)}
    </div>
    <div class="row between" style="margin-top:10px">
      <span class="muted small">Hour of day</span>
      <div class="legend-scale">Fewer ${[1, 2, 3, 4, 5, 6].map((s) => html`<span class="sw" style="background:var(--seq-${s})"></span>`)} More (max ${max})</div>
    </div>`;
}

/** Vertical bars. items: [{ label, value, tip }] */
export function barChart(items, { height = 180, labelEvery = 1 } = {}) {
  if (!items.length) return html`<div class="empty">No data for this period</div>`;
  const max = Math.max(...items.map((i) => i.value || 0)) || 1;
  return html`
    <div class="bars" style="height:${height}px">
      ${items.map((i) => html`<div class="b" data-tip="${i.tip}"><span style="height:${((i.value || 0) / max) * 100}%"></span></div>`)}
    </div>
    <div class="bar-axis">${items.map((i, idx) => html`<span>${idx % labelEvery === 0 ? i.label : ''}</span>`)}</div>`;
}

/** Horizontal bars with direct value labels. items: [{ label, value, tip }] */
export function hbars(items, { format = (v) => v } = {}) {
  const max = Math.max(...items.map((i) => i.value || 0)) || 1;
  return html`<div class="stack" style="gap:8px">
    ${items.map((i) => html`
      <div class="hbar" data-tip="${i.tip || ''}">
        <span>${i.label}</span>
        <div class="track"><div class="fill" style="width:${((i.value || 0) / max) * 100}%"></div></div>
        <span class="num muted" style="text-align:right">${format(i.value)}</span>
      </div>`)}
  </div>`;
}

export { hourLabel, DAYS };
