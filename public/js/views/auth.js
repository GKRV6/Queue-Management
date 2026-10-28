import { api } from '../api.js';
import { html, render, formValues } from '../ui.js';
import { icon } from '../icons.js';
import { toggleTheme, themeIconName } from '../theme.js';

const DEMO = [
  { role: 'Customer', email: 'student@qws.edu', password: 'Student@123', icon: 'graduation', face: 'c' },
  { role: 'Staff', email: 'staff@qws.edu', password: 'Staff@123', icon: 'console', face: 's' },
  { role: 'Admin', email: 'admin@qws.edu', password: 'Admin@123', icon: 'shield', face: 'a' },
];
const CLOCK_TICK_MS = 15000;

/** macOS lock-screen inspired sign-in: clock, glass card, user tiles. */
export function authView(root, onLoggedIn) {
  let mode = 'login';
  let clockTimer = null;

  const clock = () => {
    const now = new Date();
    return html`
      <div class="date">${now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <div class="time">${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</div>`;
  };

  const draw = () => {
    document.title = 'Queue Without Standing';
    clearInterval(clockTimer);
    render(root, html`
      <div class="auth">
        <button class="icon-btn auth-theme" id="auth-theme" aria-label="Switch light or dark mode">${icon(themeIconName())}</button>
        <div style="width:min(440px,100%)">
          <div class="auth-clock" id="clock">${clock()}</div>
          <div class="glass auth-card">
            <div class="auth-head">
              <div class="brand-mark">${icon('ticket', { size: 34 })}</div>
              <h2 style="font-size:22px">${mode === 'login' ? 'Queue Without Standing' : 'Create your account'}</h2>
              <p>${mode === 'login' ? 'Join the line from anywhere. Arrive when it is your turn.' : 'Customers can register in seconds.'}</p>
            </div>
            ${mode === 'login' ? html`
              <div class="users-pick">
                ${DEMO.map((d, i) => html`
                  <button type="button" class="user-tile" data-demo="${i}" aria-label="Sign in as demo ${d.role}">
                    <span class="face ${d.face}">${icon(d.icon, { size: 26 })}</span>
                    <span class="nm">${d.role}</span><span class="em">${d.email}</span>
                  </button>`)}
              </div>
              <div class="divider">or sign in with email</div>` : ''}
            <form class="stack" id="auth-form" novalidate>
              ${mode === 'register' ? html`
                <div class="field"><label for="fullName">Full name</label><input class="input" id="fullName" name="fullName" autocomplete="name" required></div>
                <div class="field"><label for="phone">Phone (optional)</label><input class="input" id="phone" name="phone" autocomplete="tel" inputmode="tel"></div>` : ''}
              <div class="field"><label for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="email" required></div>
              <div class="field"><label for="password">Password</label>
                <input class="input" id="password" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required>
                ${mode === 'register' ? html`<span class="help">At least 8 characters.</span>` : ''}
              </div>
              <p class="error-text" id="auth-error" hidden></p>
              <button class="btn btn-primary btn-lg btn-block" type="submit">${mode === 'login' ? 'Sign In' : 'Create Account'}</button>
            </form>
            <p class="small muted" style="text-align:center">
              ${mode === 'login' ? 'New here?' : 'Already registered?'}
              <a href="#/" id="switch-mode">${mode === 'login' ? 'Create a customer account' : 'Sign in instead'}</a>
            </p>
          </div>
          <div class="auth-features">
            <span>${icon('ticket', { size: 16 })}Remote tokens</span>
            <span>${icon('clock', { size: 16 })}Live wait times</span>
            <span>${icon('trend', { size: 16 })}Peak-hour insight</span>
          </div>
        </div>
      </div>`);

    clockTimer = setInterval(() => {
      const el = root.querySelector('#clock');
      if (el) render(el, clock());
      else clearInterval(clockTimer);
    }, CLOCK_TICK_MS);

    root.querySelector('#auth-theme').addEventListener('click', (e) => {
      toggleTheme();
      render(e.currentTarget, icon(themeIconName()));
    });

    const form = root.querySelector('#auth-form');
    const errorEl = root.querySelector('#auth-error');
    const submit = async (values) => {
      errorEl.hidden = true;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const user = await api.post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', values);
        clearInterval(clockTimer);
        onLoggedIn(user);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        btn.disabled = false;
      }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(formValues(form)); });
    root.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => {
      const d = DEMO[Number(b.dataset.demo)];
      submit({ email: d.email, password: d.password });
    }));
    root.querySelector('#switch-mode').addEventListener('click', (e) => {
      e.preventDefault();
      mode = mode === 'login' ? 'register' : 'login';
      draw();
    });
  };
  draw();
}
