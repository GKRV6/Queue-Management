import { api } from '../api.js';
import { html, raw, esc, render, withBusy, table, fmtNum } from '../ui.js';
import { icon } from '../icons.js';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'INNER', 'ON', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS', 'GROUP', 'BY',
  'ORDER', 'HAVING', 'LIMIT', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DESC', 'ASC', 'DISTINCT', 'EXISTS', 'OVER',
  'PARTITION', 'BETWEEN', 'LIKE', 'UNION', 'CREATE', 'TABLE', 'VIEW', 'TRIGGER', 'INDEX', 'UNIQUE', 'PRIMARY', 'KEY',
  'REFERENCES', 'FOREIGN', 'CHECK', 'DEFAULT', 'INTEGER', 'TEXT', 'REAL', 'BEFORE', 'AFTER', 'INSERT', 'UPDATE', 'DELETE',
  'INTO', 'VALUES', 'SET', 'BEGIN', 'FOR', 'EACH', 'ROW', 'CASCADE', 'RESTRICT', 'RAISE', 'ABORT', 'OF', 'COLLATE',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'COALESCE', 'NULLIF', 'CAST', 'RANK', 'DENSE_RANK', 'ROW_NUMBER', 'LAG',
];
const TOKEN_RE = new RegExp(`(--[^\\n]*)|('(?:[^']|'')*')|\\b(${KEYWORDS.join('|')})\\b`, 'gi');

/** Minimal SQL highlighter: every fragment is escaped before being wrapped. */
function highlight(sql) {
  let out = '';
  let last = 0;
  for (const m of sql.matchAll(TOKEN_RE)) {
    out += esc(sql.slice(last, m.index));
    if (m[1]) out += `<span class="cm">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="str">${esc(m[2])}</span>`;
    else out += `<span class="kw">${esc(m[3])}</span>`;
    last = m.index + m[0].length;
  }
  return raw(out + esc(sql.slice(last)));
}

const sqlBlock = (sql) => html`<pre class="sql">${highlight(sql)}</pre>`;

// ------------------------------------------------------------------ reports
export async function reportsView(ctx) {
  ctx.setTitle('SQL reports', 'Meaningful queries from db/queries.sql, executed live against the database');
  const reports = await api.get('/api/admin/reports');
  let current = reports[0]?.name;

  render(ctx.el, html`
    <div class="grid" style="grid-template-columns:minmax(220px,300px) minmax(0,1fr);align-items:start" id="reports-grid">
      <div class="card"><div class="card-head"><h2>${reports.length} reports</h2></div>
        <div class="report-list">${reports.map((r) => html`
          <button class="report-item" data-report="${r.name}"><div class="t">${r.title}</div><div class="c">${r.concepts}</div></button>`)}</div></div>
      <div class="stack" id="report-out"></div>
    </div>`);
  if (window.matchMedia('(max-width: 860px)').matches) ctx.el.querySelector('#reports-grid').style.gridTemplateColumns = '1fr';

  const out = ctx.el.querySelector('#report-out');
  const run = async (name) => {
    current = name;
    ctx.el.querySelectorAll('[data-report]').forEach((b) => b.classList.toggle('on', b.dataset.report === name));
    render(out, html`<div class="card loading"><span class="spinner"></span></div>`);
    const r = await api.get(`/api/admin/reports/${encodeURIComponent(name)}`);
    if (!ctx.isCurrent() || current !== name) return;
    render(out, html`
      <div class="card">
        <div class="card-head"><div><h2>${r.title}</h2><div class="hint">${r.description}</div></div>
          <button class="btn btn-sm" id="rerun">${icon('refresh', { size: 14 })}Run Again</button></div>
        <div class="card-body stack">
          <div class="row">${r.concepts.split(',').map((c) => html`<span class="tag">${c.trim()}</span>`)}</div>
          ${sqlBlock(r.sql)}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Result</h2><span class="muted small">${fmtNum(r.rows.length)} rows · ${r.elapsedMs} ms</span></div>
        <div class="card-body flush" style="max-height:520px;overflow:auto">${table(
          r.columns.map((c) => ({ label: c, key: c, num: r.rows.length > 0 && typeof r.rows[0][c] === 'number' })),
          r.rows,
          { empty: 'The query returned no rows' },
        )}</div>
      </div>`);
    out.querySelector('#rerun').addEventListener('click', (e) => withBusy(e.currentTarget, () => run(name)));
  };

  ctx.el.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () => run(b.dataset.report)));
  if (current) await run(current);
}

// ------------------------------------------------------------------ schema
export async function schemaView(ctx) {
  ctx.setTitle('Schema explorer', 'Tables, keys, views, triggers and indexes read live from sqlite_master');
  const s = await api.get('/api/admin/schema');
  const totalRows = s.tables.reduce((n, t) => n + t.rows, 0);

  const tableDetail = (t) => html`
    <details class="obj">
      <summary><span class="chev">${icon('chevronRight', { size: 14 })}</span><b>${t.name}</b><span class="muted small">${t.columns.length} columns · ${t.foreignKeys.length} foreign keys</span>
        <span class="spacer"></span><span class="num">${fmtNum(t.rows)} rows</span></summary>
      <div class="inner">
        <table class="schema-cols"><thead><tr><th>Column</th><th>Type</th><th>Constraints</th><th>Default</th></tr></thead><tbody>
          ${t.columns.map((c) => {
            const fk = t.foreignKeys.find((f) => f.from === c.name);
            return html`<tr>
              <td><code>${c.name}</code></td><td>${c.type}</td>
              <td>${c.pk ? html`<span class="badge plain open">PK</span> ` : ''}${fk ? html`<span class="badge plain waiting" data-tip="ON DELETE ${fk.on_delete}">FK ${fk.table}.${fk.to}</span> ` : ''}${c.not_null ? html`<span class="tag">NOT NULL</span>` : ''}</td>
              <td class="muted small">${c.dflt_value ?? ''}</td></tr>`;
          })}
        </tbody></table>
        ${sqlBlock(t.sql)}
      </div>
    </details>`;

  const objList = (items, label) => html`
    <div class="card">
      <div class="card-head"><h2>${label}</h2><span class="muted small">${items.length}</span></div>
      <div>${items.map((o) => html`
        <details class="obj"><summary><span class="chev">${icon('chevronRight', { size: 14 })}</span><b>${o.name}</b><span class="muted small">on ${o.table}</span></summary>
          <div class="inner">${sqlBlock(o.sql)}</div></details>`)}</div>
    </div>`;

  render(ctx.el, html`
    <div class="kpis">
      <div class="card kpi"><div class="label">Tables</div><div class="value">${s.tables.length}</div><div class="foot">${fmtNum(totalRows)} rows in total</div></div>
      <div class="card kpi"><div class="label">Views</div><div class="value">${s.views.length}</div></div>
      <div class="card kpi"><div class="label">Triggers</div><div class="value">${s.triggers.length}</div></div>
      <div class="card kpi"><div class="label">Indexes</div><div class="value">${s.indexes.length}</div></div>
    </div>
    <div class="card"><div class="card-head"><div><h2>Tables</h2><div class="hint">Click a table to see its columns, keys and DDL</div></div></div>
      <div>${s.tables.map(tableDetail)}</div></div>
    <div class="grid grid-2">${objList(s.views, 'Views')}${objList(s.triggers, 'Triggers')}</div>
    ${objList(s.indexes, 'Indexes')}`);
}
