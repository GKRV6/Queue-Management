import { api } from '../api.js';
import {
  html, render, toast, openModal, confirmDialog, withBusy, statusBadge, table, fmtDate, fmtDateTime,
} from '../ui.js';
import { icon, appIcon } from '../icons.js';

const CATEGORIES = ['canteen', 'photocopy', 'clinic', 'office', 'library', 'other'];

const field = (label, name, value = '', attrs = '') => html`
  <div class="field"><label for="f-${name}">${label}</label>
    <input class="input" id="f-${name}" name="${name}" value="${value ?? ''}" ${attrs ? html([attrs]) : ''}></div>`;

const selectField = (label, name, options, selected) => html`
  <div class="field"><label for="f-${name}">${label}</label>
    <select class="input" id="f-${name}" name="${name}">
      ${options.map(([v, t]) => html`<option value="${v}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${t}</option>`)}
    </select></div>`;

// ------------------------------------------------------------------ centers
function centerForm(c = {}) {
  return html`<div class="form-grid">
    <div class="full">${field('Name', 'name', c.name, 'required maxlength="80"')}</div>
    ${selectField('Category', 'category', CATEGORIES.map((x) => [x, x[0].toUpperCase() + x.slice(1)]), c.category || 'canteen')}
    ${field('Location', 'location', c.location, 'required maxlength="120"')}
    ${field('Opens at', 'openingTime', c.opening_time, 'type="time" required')}
    ${field('Closes at', 'closingTime', c.closing_time, 'type="time" required')}
    <div class="full field"><label for="f-description">Description</label>
      <textarea class="input" id="f-description" name="description" maxlength="300">${c.description || ''}</textarea></div>
  </div>`;
}

export async function centersView(ctx) {
  ctx.setTitle('Centers & counters', 'Service centers, the services they offer, counters and booking slots');
  const load = async () => {
    const centers = await api.get('/api/admin/centers');
    if (!ctx.isCurrent()) return;
    render(ctx.el, html`
      <div class="row between"><span class="muted">${centers.length} service centers</span>
        <button class="btn btn-primary" id="add-center">${icon('plus', { size: 16 })}Add Service Center</button></div>
      <div class="grid grid-auto">${centers.map((c) => html`
        <a class="card widget" href="#/centers/${c.center_id}">
          <div class="top">${appIcon(c.category, 46)}
            <div style="flex:1"><h3>${c.name}</h3>
            <div class="muted small">${c.location} · ${c.opening_time}–${c.closing_time}</div>
            <div style="margin-top:6px">${c.is_active ? html`<span class="badge open">Active</span>` : html`<span class="badge closed">Inactive</span>`}</div></div></div>
          <div class="stats">
            <div class="stat"><div class="v">${c.total_counters}</div><div class="k">counters</div></div>
            <div class="stat"><div class="v">${c.waiting_count}</div><div class="k">waiting</div></div>
            <div class="stat"><div class="v">${c.served_today}</div><div class="k">served today</div></div>
          </div>
        </a>`)}</div>`);
    ctx.el.querySelector('#add-center').addEventListener('click', async () => {
      const created = await openModal({
        title: 'Add service center', body: centerForm(), submitLabel: 'Create center',
        onSubmit: (v) => api.post('/api/admin/centers', v),
      });
      if (created) {
        toast('Center created — now add its services and counters', 'success');
        window.location.hash = `#/centers/${created.center_id}`;
      }
    });
  };
  await load();
}

function serviceForm(s = {}) {
  return html`<div class="form-grid">
    ${field('Service name', 'name', s.name, 'required maxlength="80"')}
    ${field('Token code (1–3 letters)', 'code', s.code, 'required maxlength="3" style="text-transform:uppercase"')}
    ${field('Average service minutes', 'avgServiceMinutes', s.avg_service_minutes, 'type="number" step="0.5" min="0.5" max="240" required')}
    ${field('Fee (₹)', 'fee', s.fee ?? 0, 'type="number" step="1" min="0"')}
    <div class="full">${field('Description', 'description', s.description, 'maxlength="300"')}</div>
  </div>`;
}

function counterForm(services, c = {}) {
  const selected = new Set(c.service_ids || []);
  return html`<div class="form-grid">
    ${c.counter_id ? '' : field('Counter number', 'counterNumber', c.counter_number, 'type="number" min="1" max="99" required')}
    <div class="${c.counter_id ? 'full' : ''}">${field('Label', 'label', c.label, 'required maxlength="40" placeholder="e.g. Counter 4 - Juice"')}</div>
    <div class="full field"><label>Services handled at this counter</label>
      <div class="row">${services.map((s) => html`
        <label class="check"><input type="checkbox" name="serviceTypeIds" data-multi value="${s.service_type_id}" ${selected.has(s.service_type_id) ? 'checked' : ''}>${s.name}</label>`)}</div>
    </div>
  </div>`;
}

export async function centerConfigView(ctx) {
  const id = Number(ctx.params[0]);
  const load = async () => {
    const cfg = await api.get(`/api/admin/centers/${id}`);
    if (!ctx.isCurrent()) return;
    const c = cfg.center;
    ctx.setTitle(c.name, `${c.category} · ${c.location}`);
    render(ctx.el, html`
      <div class="row between"><a href="#/centers" class="btn btn-sm">${icon('chevronLeft', { size: 15 })}All centers</a>
        <div class="row">
          <button class="btn" id="toggle-center">${c.is_active ? 'Deactivate center' : 'Activate center'}</button>
          <button class="btn btn-primary" id="edit-center">Edit details</button></div></div>

      <div class="card">
        <div class="card-head"><div><h2>Services</h2><div class="hint">Each service gets its own daily queue and token prefix. "Learned" time is the real 30-day average.</div></div>
          <button class="btn btn-sm btn-primary" id="add-service">${icon('plus', { size: 14 })}Add Service</button></div>
        <div class="card-body flush">${table([
          { label: 'Service', render: (s) => html`<b>${s.name}</b> <span class="tag">${s.code}</span><div class="muted small">${s.description || ''}</div>` },
          { label: 'Configured', num: true, render: (s) => `${s.avg_service_minutes} min` },
          { label: 'Learned', num: true, render: (s) => html`<span data-tip="${s.sample_size} services in the last 30 days">${s.est_service_minutes} min</span>` },
          { label: 'Fee', num: true, render: (s) => `₹${s.fee}` },
          { label: 'Status', render: (s) => (s.is_active ? statusBadge('open') : html`<span class="badge closed">Inactive</span>`) },
          { label: '', render: (s) => html`<div class="row" style="gap:6px;flex-wrap:nowrap">
              <button class="btn btn-sm" data-edit-service="${s.service_type_id}">Edit</button>
              <button class="btn btn-sm btn-ghost" data-toggle-service="${s.service_type_id}" data-active="${s.is_active}">${s.is_active ? 'Disable' : 'Enable'}</button></div>` },
        ], cfg.services, { empty: 'No services yet' })}</div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Counters</h2><div class="hint">Which services each counter handles drives the "call next" logic.</div></div>
          <button class="btn btn-sm btn-primary" id="add-counter" ${cfg.services.length ? '' : 'disabled'}>${icon('plus', { size: 14 })}Add Counter</button></div>
        <div class="card-body flush">${table([
          { label: 'No.', num: true, key: 'counter_number' },
          { label: 'Label', render: (k) => html`<b>${k.label}</b>` },
          { label: 'Status', render: (k) => statusBadge(k.status) },
          { label: 'Services', render: (k) => k.service_ids.map((sid) => html`<span class="tag">${cfg.services.find((s) => s.service_type_id === sid)?.code ?? sid}</span> `) },
          { label: 'Staff', render: (k) => k.staff_name || html`<span class="muted">Unassigned</span>` },
          { label: '', render: (k) => html`<button class="btn btn-sm" data-edit-counter="${k.counter_id}">Edit</button>` },
        ], cfg.counters, { empty: 'No counters yet' })}</div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Booking time slots</h2><div class="hint">Customers may reserve a slot; capacity is enforced by a trigger.</div></div>
          <button class="btn btn-sm btn-primary" id="add-slot">${icon('plus', { size: 14 })}Add Slot</button></div>
        <div class="card-body flush">${table([
          { label: 'Slot', render: (s) => html`<b>${s.start_time} – ${s.end_time}</b>` },
          { label: 'Capacity / day', num: true, key: 'max_tokens' },
          { label: 'Bookings (all time)', num: true, key: 'total_bookings' },
          { label: '', render: (s) => html`<div class="row" style="gap:6px;flex-wrap:nowrap">
              <button class="btn btn-sm" data-cap-slot="${s.slot_id}" data-cap="${s.max_tokens}">Capacity</button>
              <button class="btn btn-sm btn-danger" data-del-slot="${s.slot_id}">Delete</button></div>` },
        ], cfg.slots, { empty: 'No booking slots — customers can only join the live queue' })}</div>
      </div>`);
    bind(cfg);
  };

  const bind = (cfg) => {
    const $ = (sel) => ctx.el.querySelector(sel);
    const $$ = (sel) => ctx.el.querySelectorAll(sel);
    const after = (msg) => async (r) => { if (r) { toast(msg, 'success'); await load(); } };

    $('#edit-center').addEventListener('click', () => openModal({
      title: 'Edit service center', body: centerForm(cfg.center),
      onSubmit: (v) => api.patch(`/api/admin/centers/${id}`, v),
    }).then(after('Center updated')));
    $('#toggle-center').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      await api.patch(`/api/admin/centers/${id}`, { isActive: !cfg.center.is_active });
      await after(cfg.center.is_active ? 'Center deactivated' : 'Center activated')(true);
    }));
    $('#add-service').addEventListener('click', () => openModal({
      title: 'Add service', body: serviceForm(), submitLabel: 'Add service',
      onSubmit: (v) => api.post('/api/admin/service-types', { ...v, centerId: id }),
    }).then(after('Service added')));
    $$('[data-edit-service]').forEach((b) => b.addEventListener('click', () => {
      const s = cfg.services.find((x) => x.service_type_id === Number(b.dataset.editService));
      openModal({
        title: `Edit ${s.name}`, body: serviceForm(s),
        onSubmit: (v) => api.patch(`/api/admin/service-types/${s.service_type_id}`, v),
      }).then(after('Service updated'));
    }));
    $$('[data-toggle-service]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
      await api.patch(`/api/admin/service-types/${b.dataset.toggleService}`, { isActive: b.dataset.active !== '1' });
      await after('Service updated')(true);
    })));
    $('#add-counter').addEventListener('click', () => openModal({
      title: 'Add counter', body: counterForm(cfg.services, { counter_number: cfg.counters.length + 1 }), submitLabel: 'Add counter',
      onSubmit: (v) => api.post('/api/admin/counters', { ...v, centerId: id, serviceTypeIds: v.serviceTypeIds.map(Number) }),
    }).then(after('Counter added')));
    $$('[data-edit-counter]').forEach((b) => b.addEventListener('click', () => {
      const k = cfg.counters.find((x) => x.counter_id === Number(b.dataset.editCounter));
      openModal({
        title: `Edit ${k.label}`,
        body: html`${counterForm(cfg.services, k)}${selectField('Status', 'status', [['open', 'Open'], ['paused', 'Paused'], ['closed', 'Closed']], k.status)}`,
        onSubmit: (v) => api.patch(`/api/admin/counters/${k.counter_id}`, { ...v, serviceTypeIds: v.serviceTypeIds.map(Number) }),
      }).then(after('Counter updated'));
    }));
    $('#add-slot').addEventListener('click', () => openModal({
      title: 'Add booking slot', submitLabel: 'Add slot',
      body: html`<div class="form-grid">
        ${field('Starts', 'startTime', '', 'type="time" required')}
        ${field('Ends', 'endTime', '', 'type="time" required')}
        <div class="full">${field('Capacity (tokens per day)', 'maxTokens', 10, 'type="number" min="1" max="500" required')}</div></div>`,
      onSubmit: (v) => api.post('/api/admin/time-slots', { ...v, centerId: id, maxTokens: Number(v.maxTokens) }),
    }).then(after('Slot added')));
    $$('[data-cap-slot]').forEach((b) => b.addEventListener('click', () => openModal({
      title: 'Change slot capacity',
      body: field('Capacity (tokens per day)', 'maxTokens', b.dataset.cap, 'type="number" min="1" max="500" required'),
      onSubmit: (v) => api.patch(`/api/admin/time-slots/${b.dataset.capSlot}`, { maxTokens: Number(v.maxTokens) }),
    }).then(after('Capacity updated'))));
    $$('[data-del-slot]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Delete this slot?', message: 'Existing tokens keep their place; their slot reference is cleared (ON DELETE SET NULL).', confirmLabel: 'Delete', danger: true });
      if (ok) await withBusy(b, async () => { await api.del(`/api/admin/time-slots/${b.dataset.delSlot}`); await after('Slot deleted')(true); });
    }));
  };

  await load();
}

// ------------------------------------------------------------------ staff
export async function staffView(ctx) {
  ctx.setTitle('Staff', 'Service staff and their counter assignments');
  const centers = await api.get('/api/admin/centers', {});
  const centerCounters = async (centerId) => (await api.get(`/api/admin/centers/${centerId}`)).counters;

  const staffForm = async (s = {}) => {
    const centerId = s.center_id || centers[0]?.center_id;
    const counters = centerId ? await centerCounters(centerId) : [];
    return html`<div class="form-grid">
      ${s.staff_id ? '' : html`
        ${field('Full name', 'fullName', '', 'required maxlength="100"')}
        ${field('Email', 'email', '', 'type="email" required')}
        ${field('Phone', 'phone', '', 'inputmode="tel"')}
        ${field('Temporary password', 'password', '', 'type="text" minlength="8" required placeholder="min. 8 characters"')}`}
      ${selectField('Service center', 'centerId', centers.map((c) => [c.center_id, c.name]), centerId)}
      <div class="field"><label for="f-counterId">Counter</label>
        <select class="input" id="f-counterId" name="counterId">${counterOptions(counters, s.counter_id)}</select></div>
      <div class="full">${field('Designation', 'designation', s.designation, 'required maxlength="60" placeholder="e.g. Canteen Cashier"')}</div>
    </div>`;
  };
  const counterOptions = (counters, selected) => html`<option value="">— No counter —</option>${counters.map((k) => html`
    <option value="${k.counter_id}" ${k.counter_id === selected ? 'selected' : ''}>${k.label}${k.staff_name ? ` (${k.staff_name})` : ''}</option>`)}`;
  const linkCenterSelect = (form) => {
    form.elements.centerId.addEventListener('change', async (e) => {
      render(form.elements.counterId, counterOptions(await centerCounters(e.target.value)));
    });
  };

  const load = async () => {
    const rows = await api.get('/api/admin/staff');
    if (!ctx.isCurrent()) return;
    render(ctx.el, html`
      <div class="row between"><span class="muted">${rows.length} staff members</span>
        <button class="btn btn-primary" id="add-staff">${icon('plus', { size: 16 })}Add Staff Member</button></div>
      <div class="card"><div class="card-body flush">${table([
        { label: 'Name', render: (s) => html`<b>${s.full_name}</b><div class="muted small">${s.email}</div>` },
        { label: 'Designation', key: 'designation' },
        { label: 'Center', key: 'center_name' },
        { label: 'Counter', render: (s) => s.counter_label || html`<span class="muted">Unassigned</span>` },
        { label: 'On duty', render: (s) => (s.is_on_duty ? statusBadge('open') : statusBadge('closed')) },
        { label: 'Total served', num: true, key: 'total_served' },
        { label: 'Since', render: (s) => fmtDate(s.joined_on) },
        { label: '', render: (s) => html`<button class="btn btn-sm" data-edit="${s.staff_id}">Reassign</button>` },
      ], rows)}</div></div>`);

    ctx.el.querySelector('#add-staff').addEventListener('click', async () => {
      const r = await openModal({
        title: 'Add staff member', subtitle: 'Creates the login account and the staff profile in one transaction.',
        body: await staffForm(), submitLabel: 'Create staff', onMount: linkCenterSelect,
        onSubmit: (v) => api.post('/api/admin/staff', {
          ...v, centerId: Number(v.centerId), counterId: v.counterId ? Number(v.counterId) : undefined, phone: v.phone || undefined,
        }),
      });
      if (r) { toast('Staff member created', 'success'); await load(); }
    });
    ctx.el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const s = rows.find((x) => x.staff_id === Number(b.dataset.edit));
      const r = await openModal({
        title: `Reassign ${s.full_name}`, body: await staffForm(s), onMount: linkCenterSelect,
        onSubmit: (v) => api.patch(`/api/admin/staff/${s.staff_id}`, {
          centerId: Number(v.centerId), counterId: v.counterId ? Number(v.counterId) : null, designation: v.designation,
        }),
      });
      if (r) { toast('Assignment updated', 'success'); await load(); }
    }));
  };
  await load();
}

// ------------------------------------------------------------------ users
export async function usersView(ctx) {
  ctx.setTitle('Users', 'Every account in the system');
  const filters = { role: '', search: '' };
  let searchTimer;
  render(ctx.el, html`
    <div class="card"><div class="card-body row">
      <div class="field" style="flex:1;min-width:220px"><label for="u-search">Search</label>
        <input class="input" id="u-search" placeholder="Name or email"></div>
      <div class="field"><label>Role</label><div class="seg" id="u-role">
        ${[['', 'All'], ['customer', 'Customers'], ['staff', 'Staff'], ['admin', 'Admins']].map(([v, t]) => html`<button data-role="${v}" class="${v === '' ? 'on' : ''}">${t}</button>`)}
      </div></div>
    </div></div>
    <div id="u-table"></div>`);

  const load = async () => {
    const rows = await api.get('/api/admin/users', filters);
    if (!ctx.isCurrent()) return;
    render(ctx.el.querySelector('#u-table'), html`<div class="card"><div class="card-head"><h2>${rows.length} users</h2><span class="muted small">max 200 shown</span></div>
      <div class="card-body flush">${table([
        { label: 'Name', render: (u) => html`<b>${u.full_name}</b><div class="muted small">${u.email}</div>` },
        { label: 'Role', render: (u) => html`<span class="tag">${u.role}</span>` },
        { label: 'Phone', render: (u) => u.phone || '-' },
        { label: 'Tokens', num: true, key: 'tokens' },
        { label: 'Last visit', render: (u) => (u.last_visit ? fmtDateTime(u.last_visit) : html`<span class="muted">never</span>`) },
        { label: 'Joined', render: (u) => fmtDate(u.created_at) },
        { label: 'Status', render: (u) => (u.is_active ? html`<span class="badge open">Active</span>` : html`<span class="badge no_show">Inactive</span>`) },
        { label: '', render: (u) => (u.user_id === ctx.user.user_id ? html`<span class="muted small">you</span>`
          : html`<button class="btn btn-sm ${u.is_active ? 'btn-danger' : ''}" data-user="${u.user_id}" data-active="${u.is_active}">${u.is_active ? 'Deactivate' : 'Activate'}</button>`) },
      ], rows, { empty: 'No users match' })}</div></div>`);
    ctx.el.querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
      await api.patch(`/api/admin/users/${b.dataset.user}`, { isActive: b.dataset.active !== '1' });
      toast('User updated');
      await load();
    })));
  };

  ctx.el.querySelector('#u-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { filters.search = e.target.value.trim(); load(); }, 250);
  });
  ctx.el.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
    filters.role = b.dataset.role;
    ctx.el.querySelectorAll('[data-role]').forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  await load();
}

