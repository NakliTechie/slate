// Recently used colours — shared across every tool that has a colour setting.
// Persisted to localStorage so the swatches survive reloads.

const KEY = 'slate.v1.recent-colors';
const MAX = 8;
let _list = null;

function load() {
  if (_list !== null) return;
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    _list = Array.isArray(arr)
      ? arr.filter(c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, MAX)
      : [];
  } catch { _list = []; }
}

export function getRecentColors() {
  load();
  return _list.slice();
}

export function pushRecentColor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const norm = hex.toLowerCase();
  load();
  const out = _list.filter(c => c !== norm);
  out.unshift(norm);
  _list = out.slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(_list)); } catch {}
}
