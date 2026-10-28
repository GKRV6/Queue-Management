// SF-Symbols-style line icons (24x24, stroke = currentColor). No emoji anywhere in the UI.
import { raw } from './ui.js';

const PATHS = {
  ticket: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z"/><path d="M14.5 6.5v11" stroke-dasharray="1.6 2.2"/>',
  building: '<path d="M4.5 21V5.2a1.2 1.2 0 0 1 1.2-1.2h7.6a1.2 1.2 0 0 1 1.2 1.2V21"/><path d="M14.5 9.5h3.8a1.2 1.2 0 0 1 1.2 1.2V21"/><path d="M3 21h18"/><path d="M8 8h3M8 12h3M8 16h3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bell: '<path d="M6.5 16.5v-5.2a5.5 5.5 0 0 1 11 0v5.2l1.5 1.8H5z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  chart: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6.5" rx="1"/><rect x="10.5" y="6" width="3" height="11.5" rx="1"/><rect x="15.5" y="9" width="3" height="8.5" rx="1"/>',
  trend: '<path d="M4 19.5h16"/><path d="M5 15l4-4 3 3 6.5-7"/><path d="M15 7h3.5v3.5"/>',
  list: '<path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20"/><circle cx="5" cy="6.5" r="1.1"/><circle cx="5" cy="12" r="1.1"/><circle cx="5" cy="17.5" r="1.1"/>',
  star: '<path d="M12 3.8l2.5 5.1 5.6.8-4 4 .9 5.6L12 16.6l-5 2.7.9-5.6-4-4 5.6-.8z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M20.5 19.5a5 5 0 0 0-3.2-4.7"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V6"/><path d="M5 12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8"/>',
  power: '<path d="M12 3.5v7.5"/><path d="M6.6 7.4a7.5 7.5 0 1 0 10.8 0"/>',
  console: '<rect x="3" y="5" width="18" height="14" rx="3.5"/><circle cx="9" cy="11" r="2"/><path d="M5.8 16.2a3.3 3.3 0 0 1 6.4 0M14.5 10h4M14.5 13.5h3"/>',
  display: '<rect x="3" y="4" width="18" height="12.5" rx="3"/><path d="M8.5 20h7M12 16.5V20"/>',
  canteen: '<path d="M7 3.5v7.5M5 3.5v4.8a2 2 0 0 0 4 0V3.5M7 11v9.5"/><path d="M17 20.5V3.5c-2 1.4-3.2 3.8-3.2 6.8v3.4H17"/>',
  photocopy: '<path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="7.5" rx="2.2"/><path d="M7 14h10v6.5H7z"/>',
  clinic: '<rect x="3.5" y="7" width="17" height="13" rx="3"/><path d="M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7"/><path d="M12 10.5v6M9 13.5h6"/>',
  office: '<path d="M3 9l9-5 9 5"/><path d="M5.5 9.5v8.5M9.8 9.5v8.5M14.2 9.5v8.5M18.5 9.5v8.5"/><path d="M3 20.5h18"/>',
  library: '<path d="M4.5 4h4v16h-4zM10 4h4v16h-4z"/><path d="M15.6 5.4l3.6-.9 2.6 15-3.6.9z"/>',
  tag: '<path d="M3.5 12V4.5a1 1 0 0 1 1-1H12l8.5 8.5-8.5 8.5z"/><circle cx="8" cy="8" r="1.4"/>',
  hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11"/><path d="M8 3.5v2.8L12 12l-4 5.7v2.8M16 3.5v2.8L12 12l4 5.7v2.8"/>',
  megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h2.2l8.3 4V5L7.2 9H5a1 1 0 0 0-1 1z"/><path d="M18.5 9a4.2 4.2 0 0 1 0 6"/>',
  alert: '<path d="M12 4.2l8.6 15.3H3.4z"/><path d="M12 10v4.2M12 17.2v.01"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.4l2.6 2.6 4.9-5.4"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  nosign: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  refresh: '<path d="M19.5 11.5a7.5 7.5 0 1 0-2.2 5.4"/><path d="M19.5 4.5v7h-7"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2M12 7.8v.01"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16v4M16.5 18h4"/>',
  xmark: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  check: '<path d="M5.5 12.5l4.2 4.2L18.5 8"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  chevronLeft: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  chevronRight: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
  arrowUp: '<path d="M12 19V5.5M6.5 11L12 5.5 17.5 11"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  tray: '<path d="M3.5 13l2.8-7.2a1.2 1.2 0 0 1 1.1-.8h9.2a1.2 1.2 0 0 1 1.1.8l2.8 7.2v5.3a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M3.5 13h5l1.5 2.5h4l1.5-2.5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
  graduation: '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5v4.3c3.3 2.3 7.7 2.3 11 0v-4.3M21.5 9.5v5"/>',
  shield: '<path d="M12 3.5l7.5 2.8v5.6c0 4.6-3.2 7.6-7.5 8.6-4.3-1-7.5-4-7.5-8.6V6.3z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  map: '<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 9.5h17M9.5 9.5v10"/>',
  bolt: '<path d="M13 3L5 13.5h6L10.5 21 19 10.5h-6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  chair: '<path d="M7 11V5.5A1.5 1.5 0 0 1 8.5 4h7A1.5 1.5 0 0 1 17 5.5V11"/><path d="M5.5 11h13v3h-13zM7 14v6.5M17 14v6.5"/>',
};

const FILLED = {
  play: '<path d="M8 5.5v13a.8.8 0 0 0 1.2.7l10.3-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z"/>',
  starFill: '<path d="M12 3.8l2.5 5.1 5.6.8-4 4 .9 5.6L12 16.6l-5 2.7.9-5.6-4-4 5.6-.8z"/>',
  dot: '<circle cx="12" cy="12" r="5"/>',
};

export function icon(name, { size = 18, cls = '' } = {}) {
  if (FILLED[name]) {
    return raw(`<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${FILLED[name]}</svg>`);
  }
  const body = PATHS[name] || PATHS.info;
  return raw(`<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`);
}

/** App-icon style rounded square with a gradient per category. */
export function appIcon(category, size = 44) {
  const name = { canteen: 'canteen', photocopy: 'photocopy', clinic: 'clinic', office: 'office', library: 'library' }[category] || 'tag';
  return raw(`<span class="app-icon cat-${category || 'other'}" style="width:${size}px;height:${size}px">${icon(name, { size: Math.round(size * 0.52) })}</span>`);
}
