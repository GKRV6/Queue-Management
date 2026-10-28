// Light / dark theme. Follows the system until the user picks one; the choice
// is a per-browser convenience kept in localStorage.
const KEY = 'qws-theme';

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // storage blocked (private mode) - fall back to the system theme
  }
}

export function currentTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit) return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyStoredTheme() {
  const theme = stored();
  if (theme) document.documentElement.setAttribute('data-theme', theme);
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // not persisted; the theme still applies for this page view
  }
  return next;
}

/** Icon name for the button: shows what you will switch to. */
export const themeIconName = () => (currentTheme() === 'dark' ? 'sun' : 'moon');
