import { api } from './api.js';
import { html, render, toast, initTooltips, initials, timeAgo, emptyState } from './ui.js';
import { icon } from './icons.js';
import { applyStoredTheme, toggleTheme, themeIconName } from './theme.js';
import { authView } from './views/auth.js';
import * as customer from './views/customer.js';
import * as staff from './views/staff.js';
import * as admin from './views/admin.js';
import * as adminConfig from './views/adminConfig.js';
import * as adminData from './views/adminData.js';

const NOTIFICATION_POLL_MS = 10000;
const NOTIF_ICONS = {
  token_issued: 'ticket', turn_near: 'hourglass', called: 'megaphone', skipped: 'alert', completed: 'checkCircle',
  cancelled: 'xCircle', no_show: 'nosign', requeued: 'refresh', queue_update: 'info', system: 'sparkle',
};

const NAV = {
  customer: [
    { path: '', label: 'My Tokens', short: 'Tokens', icon: 'ticket', view: customer.homeView },
    { path: 'centers', label: 'Service Centers', short: 'Centers', icon: 'building', view: customer.centersView },
    { path: 'history', label: 'History & Feedback', short: 'History', icon: 'clock', view: customer.historyView },
    { path: 'notifications', label: 'Notifications', short: 'Alerts', icon: 'bell', view: notificationsView },
  ],
  staff: [
    { path: '', label: 'Counter Console', short: 'Console', icon: 'console', view: staff.consoleView },
    { path: 'centers', label: 'Live Boards', short: 'Boards', icon: 'display', view: customer.centersView },
    { path: 'notifications', label: 'Notifications', short: 'Alerts', icon: 'bell', view: notificationsView },
  ],
  admin: [
    { section: 'Monitor' },
    { path: '', label: 'Overview', short: 'Overview', icon: 'chart', view: admin.overviewView },
    { path: 'analytics', label: 'Peak-hour Analytics', short: 'Analytics', icon: 'trend', view: admin.analyticsView },
    { path: 'queues', label: 'Queues', short: 'Queues', icon: 'list', view: admin.queuesView },
    { path: 'feedback', label: 'Feedback', short: 'Feedback', icon: 'star', view: admin.feedbackView },
    { section: 'Manage' },
    { path: 'centers', label: 'Centers & Counters', short: 'Centers', icon: 'grid', view: adminConfig.centersView },
    { path: 'staff', label: 'Staff', short: 'Staff', icon: 'person', view: adminConfig.staffView },
    { path: 'users', label: 'Users', short: 'Users', icon: 'users', view: adminConfig.usersView },
    { section: 'Database' },
    { path: 'reports', label: 'SQL Reports', short: 'SQL', icon: 'terminal', view: adminData.reportsView },
    { path: 'database', label: 'Schema Explorer', short: 'Schema', icon: 'database', view: adminData.schemaView },
  ],
};

// Detail routes that are not in the sidebar
const EXTRA_ROUTES = {
  customer: [{ pattern: /^centers\/(\d+)$/, view: customer.centerDetailView, nav: 'centers' }],
  staff: [{ pattern: /^centers\/(\d+)$/, view: customer.centerDetailView, nav: 'centers' }],
  admin: [{ pattern: /^centers\/(\d+)$/, view: adminConfig.centerConfigView, nav: 'centers' }],
};

const state = { user: null, timers: [], notifTimer: null, lastNotifId: null, routeToken: 0 };
const root = document.getElementById('app');

// ------------------------------------------------------------------ boot
async function boot() {
  applyStoredTheme();
  initTooltips();
  window.addEventListener('hashchange', route);
  window.addEventListener('qws:unauthorized', () => { if (state.user) logout(false); });
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('notif-panel');
    if (panel && !panel.hidden && !e.target.closest('#notif-panel, #bell')) panel.hidden = true;
  });
  try {
    state.user = await api.get('/api/auth/me');
  } catch {
    state.user = null;
  }
  start();
}

function start() {
  stopTimers();
  clearInterval(state.notifTimer);
  if (!state.user) {
    authView(root, (user) => {
      state.user = user;
      window.location.hash = '#/';
      start();
    });
    return;
  }
  renderShell();
  route();
  refreshNotifications(true);
  state.notifTimer = setInterval(() => refreshNotifications(false), NOTIFICATION_POLL_MS);
}

async function logout(callApi = true) {
  if (callApi) {
    try { await api.post('/api/auth/logout'); } catch { /* session cookie is cleared client-side anyway */ }
  }
  state.user = null;
  state.lastNotifId = null;
  window.location.hash = '#/';
  start();
}

// ------------------------------------------------------------------ shell
function renderShell() {
  const u = state.user;
  const items = NAV[u.role].filter((n) => !n.section);
  render(root, html`
    <div class="layout">
      <aside class="sidebar" aria-label="Sidebar">
        <div class="traffic" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="brand">
          <div class="brand-mark">${icon('ticket', { size: 21 })}</div>
          <div><div class="brand-name">Queue Without Standing</div><div class="brand-sub">Smart campus queues</div></div>
        </div>
        <nav class="nav" aria-label="Main">
          ${NAV[u.role].map((item) => (item.section
            ? html`<div class="nav-label">${item.section}</div>`
            : html`<a href="#/${item.path}" data-nav="${item.path}">${icon(item.icon)}${item.label}</a>`))}
        </nav>
        <div class="user-card">
          <div class="avatar">${initials(u.full_name)}</div>
          <div class="user-meta"><div class="name">${u.full_name}</div><div class="role">${u.role}</div></div>
          <button class="icon-btn" id="logout" data-tip="Log out" aria-label="Log out" style="width:32px;height:32px">${icon('power', { size: 16 })}</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div style="min-width:0"><h1 id="page-title">&nbsp;</h1><div class="sub" id="page-sub"></div></div>
          <div class="topbar-actions">
            <span class="live-pill" id="live-indicator">Live</span>
            <button class="icon-btn" id="theme" aria-label="Switch light or dark mode" data-tip="Light / dark mode">${icon(themeIconName())}</button>
            <div style="position:relative">
              <button class="icon-btn" id="bell" aria-label="Notifications">${icon('bell')}<span class="count" id="bell-count" hidden></span></button>
              <div class="notif-panel" id="notif-panel" hidden></div>
            </div>
            <button class="icon-btn mobile-only" id="logout-m" aria-label="Log out">${icon('power', { size: 16 })}</button>
          </div>
        </header>
        <section class="content" id="content"></section>
      </main>
    </div>
    <nav class="tabbar" aria-label="Tabs">
      ${items.map((item) => html`<a href="#/${item.path}" data-nav="${item.path}">${icon(item.icon, { size: 21 })}<span>${item.short}</span></a>`)}
    </nav>`);
  root.querySelector('#logout').addEventListener('click', () => logout(true));
  root.querySelector('#logout-m').addEventListener('click', () => logout(true));
  root.querySelector('#bell').addEventListener('click', toggleNotifPanel);
  root.querySelector('#theme').addEventListener('click', (e) => {
    toggleTheme();
    render(e.currentTarget, icon(themeIconName()));
  });
}

function setTitle(title, sub = '') {
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-sub').textContent = sub;
  document.title = `${title} · Queue Without Standing`;
}

function stopTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

// ------------------------------------------------------------------ routing
function resolve(path) {
  const role = state.user.role;
  const main = NAV[role].find((n) => !n.section && n.path === path);
  if (main) return { view: main.view, params: [], nav: main.path };
  for (const r of EXTRA_ROUTES[role]) {
    const m = path.match(r.pattern);
    if (m) return { view: r.view, params: m.slice(1), nav: r.nav };
  }
  return null;
}

async function route() {
  if (!state.user) return;
  stopTimers();
  const token = ++state.routeToken;
  const path = window.location.hash.replace(/^#\/?/, '').replace(/\/$/, '');
  const match = resolve(path);
  root.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', Boolean(match) && a.dataset.nav === match.nav));
  const el = document.getElementById('content');
  window.scrollTo({ top: 0 });
  if (!match) {
    setTitle('Page not found');
    render(el, html`<div class="card">${emptyState('map', 'That page does not exist.', html`<a class="btn" href="#/">Go home</a>`)}</div>`);
    return;
  }
  render(el, html`<div class="loading"><span class="spinner"></span></div>`);
  const ctx = {
    el,
    params: match.params,
    user: state.user,
    setTitle,
    // registers a refresh loop that stops automatically on navigation
    poll(fn, ms) {
      if (token !== state.routeToken) return;
      state.timers.push(setInterval(() => {
        if (document.hidden || token !== state.routeToken) return;
        fn().catch((err) => console.warn('refresh failed', err));
      }, ms));
    },
    isCurrent: () => token === state.routeToken,
    refreshNotifications: () => refreshNotifications(false),
  };
  try {
    await match.view(ctx);
  } catch (err) {
    if (token !== state.routeToken) return;
    render(el, html`<div class="card">${emptyState('alert', err.message, html`<a class="btn" href="#/">Go home</a>`)}</div>`);
  }
}

// ------------------------------------------------------------------ notifications
async function refreshNotifications(initial) {
  if (!state.user) return;
  let data;
  try {
    data = await api.get('/api/notifications');
  } catch {
    document.getElementById('live-indicator')?.classList.add('off');
    return;
  }
  document.getElementById('live-indicator')?.classList.remove('off');
  const count = document.getElementById('bell-count');
  if (!count) return;
  count.hidden = !data.unread;
  count.textContent = data.unread > 99 ? '99+' : data.unread;

  const newest = data.items.reduce((m, n) => Math.max(m, n.notification_id), 0);
  if (!initial && state.lastNotifId !== null) {
    const fresh = data.items.filter((n) => n.notification_id > state.lastNotifId && !n.is_read);
    for (const n of fresh.slice(0, 3).reverse()) toast(n.message, n.type === 'called' ? 'success' : 'info');
  }
  state.lastNotifId = Math.max(state.lastNotifId ?? 0, newest);
  const panel = document.getElementById('notif-panel');
  if (panel && !panel.hidden) renderNotifPanel(panel, data);
}

function notifList(items) {
  if (!items.length) return emptyState('bell', 'No notifications yet');
  return html`<div class="notif-list">${items.map((n) => html`
    <div class="notif ${n.is_read ? '' : 'unread'}">
      <span class="n-icon ${n.type}">${icon(NOTIF_ICONS[n.type] || 'bell', { size: 16 })}</span>
      <div><div>${n.message}</div><div class="when">${timeAgo(n.created_at)}</div></div>
    </div>`)}</div>`;
}

function renderNotifPanel(panel, data) {
  render(panel, html`
    <div class="card-head"><h3>Notifications</h3>
      <button class="btn btn-sm" data-read-all ${data.unread ? '' : 'disabled'}>Mark all read</button></div>
    ${notifList(data.items.slice(0, 15))}
    <div style="padding:4px 16px 14px;text-align:center"><a href="#/notifications" class="small">Show all</a></div>`);
  panel.querySelector('[data-read-all]').addEventListener('click', async () => {
    await api.post('/api/notifications/read-all');
    refreshNotifications(false);
  });
}

async function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    render(panel, html`<div class="loading"><span class="spinner"></span></div>`);
    renderNotifPanel(panel, await api.get('/api/notifications'));
  }
}

async function notificationsView(ctx) {
  ctx.setTitle('Notifications', 'Alerts about your tokens and queues');
  const load = async () => {
    const data = await api.get('/api/notifications');
    if (!ctx.isCurrent()) return;
    render(ctx.el, html`
      <div class="card">
        <div class="card-head"><div><h2>All notifications</h2><div class="hint">${data.unread} unread</div></div>
          <button class="btn btn-sm" id="read-all" ${data.unread ? '' : 'disabled'}>Mark all read</button></div>
        ${notifList(data.items)}
      </div>`);
    ctx.el.querySelector('#read-all').addEventListener('click', async () => {
      await api.post('/api/notifications/read-all');
      await load();
      refreshNotifications(false);
    });
  };
  await load();
  ctx.poll(load, NOTIFICATION_POLL_MS);
}

boot();
