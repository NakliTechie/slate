import { state, FLAGS, savePrefs } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { navigateTo, navigateNext, navigatePrev } from '../core/fs.js';
import { esc } from '../core/html.js';

const PREFS_KEY = 'slate.v1.slideshow';

let _active = false;
let _paused = false;
let _timer = null;
let _idleTimer = null;
let _shuffleOrder = null;
let _shuffleIndex = 0;
let _hud = null;

const settings = {
  interval:   5,       // seconds
  transition: 'fade',  // 'none' | 'fade' | 'slide'
  shuffle:    false,
  loop:       true,
};

// ── Init ─────────────────────────────────────────────────────────────────────

export function initSlideshow() {
  if (!FLAGS.slideshow) return;
  loadSettings();
  on('slideshow:start', showSettingsModal);
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch {}
}
function saveSettings() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(settings)); } catch {}
}

// ── Settings modal ───────────────────────────────────────────────────────────

function showSettingsModal() {
  if (!state.session.files.length) {
    emit('toast', { message: 'Open a folder first to start a slideshow.', level: 'warn' });
    return;
  }

  let dlg = document.getElementById('modal-slideshow');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'modal-slideshow';
    document.body.appendChild(dlg);
  }

  const intervals = [2, 3, 5, 10, 30];
  const transitions = [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide']];

  dlg.innerHTML = `
    <div class="modal-header"><h2>Slideshow</h2></div>
    <div class="modal-fields">
      <div class="modal-field-row">
        <label>Interval</label>
        <div class="export-fmt-group">
          ${intervals.map(s => `
            <label class="export-fmt-option">
              <input type="radio" name="ss-interval" value="${s}"${settings.interval === s ? ' checked' : ''}>
              ${s}s
            </label>`).join('')}
        </div>
      </div>
      <div class="modal-field-row">
        <label>Transition</label>
        <div class="export-fmt-group">
          ${transitions.map(([v,l]) => `
            <label class="export-fmt-option">
              <input type="radio" name="ss-trans" value="${v}"${settings.transition === v ? ' checked' : ''}>
              ${l}
            </label>`).join('')}
        </div>
      </div>
      <div class="modal-field-row">
        <label><input type="checkbox" id="ss-shuffle"${settings.shuffle ? ' checked' : ''}> Shuffle</label>
      </div>
      <div class="modal-field-row">
        <label><input type="checkbox" id="ss-loop"${settings.loop ? ' checked' : ''}> Loop at end</label>
      </div>
      <p class="modal-info">${esc(state.session.files.length)} image${state.session.files.length === 1 ? '' : 's'} in this album. Esc exits, Space pauses, arrows navigate.</p>
    </div>
    <div class="modal-footer">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-start>
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-play"/></svg>
        Start
      </button>
    </div>
  `;

  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-start]').addEventListener('click', () => {
    settings.interval   = +dlg.querySelector('input[name="ss-interval"]:checked').value;
    settings.transition = dlg.querySelector('input[name="ss-trans"]:checked').value;
    settings.shuffle    = dlg.querySelector('#ss-shuffle').checked;
    settings.loop       = dlg.querySelector('#ss-loop').checked;
    saveSettings();
    dlg.close();
    start();
  });

  dlg.showModal();
}

// ── Playback ─────────────────────────────────────────────────────────────────

function start() {
  if (_active) return;
  _active = true;
  _paused = false;

  if (settings.shuffle) buildShuffleOrder();

  document.getElementById('app')?.classList.add('slideshow-active');
  document.documentElement.requestFullscreen?.().catch(() => {});

  window.addEventListener('keydown', onKey, true);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  buildHUD();
  scheduleNext();
}

function stop() {
  if (!_active) return;
  _active = false;
  clearTimeout(_timer);
  clearTimeout(_idleTimer);

  window.removeEventListener('keydown', onKey, true);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('fullscreenchange', onFullscreenChange);

  document.getElementById('app')?.classList.remove('slideshow-active');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});

  const canvas = document.getElementById('main-canvas');
  if (canvas) { canvas.style.transition = ''; canvas.style.opacity = ''; canvas.style.transform = ''; }

  destroyHUD();
}

function scheduleNext() {
  clearTimeout(_timer);
  if (_paused || !_active) return;
  _timer = setTimeout(advance, settings.interval * 1000);
}

async function advance(direction = 1) {
  if (!_active) return;
  clearTimeout(_timer);

  const files = state.session.files;
  if (!files.length) { stop(); return; }

  // Choose next target
  let nextIndex;
  if (settings.shuffle) {
    _shuffleIndex = (_shuffleIndex + direction + _shuffleOrder.length) % _shuffleOrder.length;
    if (_shuffleIndex === 0 && direction > 0 && !settings.loop) { stop(); return; }
    nextIndex = _shuffleOrder[_shuffleIndex];
  } else {
    const { currentIndex } = state.session;
    nextIndex = currentIndex + direction;
    if (nextIndex >= files.length) {
      if (!settings.loop) { stop(); return; }
      nextIndex = 0;
    } else if (nextIndex < 0) {
      nextIndex = settings.loop ? files.length - 1 : 0;
    }
  }

  await playTransition(async () => { await navigateTo(nextIndex); });
  updateHUDInfo();
  scheduleNext();
}

async function playTransition(navigateFn) {
  const canvas = document.getElementById('main-canvas');
  if (!canvas) { await navigateFn(); return; }

  if (settings.transition === 'none') {
    await navigateFn();
    return;
  }

  if (settings.transition === 'fade') {
    canvas.style.transition = 'opacity 240ms ease';
    canvas.style.opacity = '0';
    await wait(240);
    await navigateFn();
    canvas.style.opacity = '1';
    return;
  }

  if (settings.transition === 'slide') {
    canvas.style.transition = 'transform 280ms ease, opacity 280ms ease';
    canvas.style.transform = 'translateX(-8%)';
    canvas.style.opacity = '0';
    await wait(280);
    canvas.style.transition = 'none';
    canvas.style.transform = 'translateX(8%)';
    await navigateFn();
    await raf();
    canvas.style.transition = 'transform 280ms ease, opacity 280ms ease';
    canvas.style.transform = 'translateX(0)';
    canvas.style.opacity = '1';
  }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function raf()     { return new Promise(r => requestAnimationFrame(r)); }

function togglePause() {
  _paused = !_paused;
  if (_paused) clearTimeout(_timer); else scheduleNext();
  updateHUDInfo();
}

function buildShuffleOrder() {
  _shuffleOrder = state.session.files.map((_, i) => i);
  // Fisher–Yates
  for (let i = _shuffleOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [_shuffleOrder[i], _shuffleOrder[j]] = [_shuffleOrder[j], _shuffleOrder[i]];
  }
  // Put the currently displayed image first so the user sees it before we advance
  const cur = state.session.currentIndex;
  const pos = _shuffleOrder.indexOf(cur);
  if (pos > 0) { _shuffleOrder.splice(pos, 1); _shuffleOrder.unshift(cur); }
  _shuffleIndex = 0;
}

// ── HUD ──────────────────────────────────────────────────────────────────────

function buildHUD() {
  destroyHUD();
  _hud = document.createElement('div');
  _hud.id = 'slideshow-hud';
  _hud.innerHTML = `
    <div class="ss-info">
      <span class="ss-pos"></span>
      <span class="ss-name"></span>
    </div>
    <div class="ss-controls">
      <button class="ss-btn" data-ss="prev" aria-label="Previous">
        <svg class="icon icon-sm" aria-hidden="true" style="transform:rotate(180deg)"><use href="#icon-play"/></svg>
      </button>
      <button class="ss-btn ss-play" data-ss="pause" aria-label="Pause">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-play"/></svg>
      </button>
      <button class="ss-btn" data-ss="next" aria-label="Next">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-play"/></svg>
      </button>
      <button class="ss-btn" data-ss="exit" aria-label="Exit">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-x"/></svg>
      </button>
    </div>
  `;
  document.body.appendChild(_hud);
  _hud.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ss]');
    if (!t) return;
    const a = t.dataset.ss;
    if (a === 'prev')  advance(-1);
    else if (a === 'next')  advance(1);
    else if (a === 'pause') togglePause();
    else if (a === 'exit')  stop();
  });
  updateHUDInfo();
  showHUDTemporarily();
}

function destroyHUD() {
  _hud?.remove();
  _hud = null;
}

function updateHUDInfo() {
  if (!_hud) return;
  const { currentIndex, files } = state.session;
  const entry = files[currentIndex];
  _hud.querySelector('.ss-pos').textContent = `${currentIndex + 1} / ${files.length}`;
  _hud.querySelector('.ss-name').textContent = entry?.name ?? '';
  _hud.querySelector('.ss-play').setAttribute('aria-label', _paused ? 'Play' : 'Pause');
  _hud.classList.toggle('paused', _paused);
}

function showHUDTemporarily() {
  if (!_hud) return;
  _hud.classList.add('visible');
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => _hud?.classList.remove('visible'), 2200);
}

// ── Events ───────────────────────────────────────────────────────────────────

function onKey(e) {
  if (!_active) return;
  if (e.key === 'Escape')     { e.preventDefault(); stop(); }
  else if (e.key === ' ')     { e.preventDefault(); togglePause(); showHUDTemporarily(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); advance(1); }
  else if (e.key === 'ArrowLeft')  { e.preventDefault(); advance(-1); }
}

function onMouseMove() {
  showHUDTemporarily();
}

function onFullscreenChange() {
  // User exited fullscreen (via browser chrome) — stop the slideshow too
  if (_active && !document.fullscreenElement) stop();
}
