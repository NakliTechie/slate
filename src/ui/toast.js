import { on } from '../core/events.js';
import { esc } from '../core/html.js';

const MAX_TOASTS = 3;
let container;

function icon(level) {
  const map = { error: 'warn', warn: 'warn', ok: 'check', info: 'info' };
  const id = map[level] ?? 'info';
  return `<svg class="icon icon-sm" aria-hidden="true"><use href="#icon-${id}"/></svg>`;
}

function show({ message, level = 'info', duration = 3000 }) {
  if (!container) container = document.getElementById('toasts');
  if (!container) return;

  // Cap at MAX_TOASTS
  while (container.children.length >= MAX_TOASTS) {
    container.firstElementChild?.remove();
  }

  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `${icon(level)}<span>${esc(message)}</span>`;
  container.appendChild(el);

  setTimeout(() => {
    el.style.transition = `opacity ${150}ms`;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 160);
  }, duration);
}

export function initToasts() {
  on('toast', show);
  on('error', (e) => show({ message: e.message, level: 'error', duration: 5000 }));
}
