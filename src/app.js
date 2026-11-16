import { state, loadPrefs, savePrefs } from './core/state.js';
import { emit, on, once } from './core/events.js';
import { hasFSA, hasDirPicker, openFileFSA, openFileFallback, openFolderFSA, openFromClipboard, handleDrop, navigateNext, navigatePrev, navigateFirst, navigateLast, navigateSkip } from './core/fs.js';

import { initViewer, fitToWindow, zoomStep, zoomTo, toggleFullscreen } from './ui/viewer.js';
import { initRulers, setRulersVisible } from './ui/rulers.js';
import { initThumbstrip, toggleThumbstrip } from './ui/thumbstrip.js';
import { initToolbar } from './ui/toolbar.js';
import { initPanels, showPanel } from './ui/panels.js';
import { initSelection, clearSelection, selectAll, nudgeSelection } from './ui/selection.js';
import { initToasts } from './ui/toast.js';
import { initBatch } from './ui/batch.js';
import { initSlideshow } from './ui/slideshow.js';
import { initRightSidebar } from './ui/rightsidebar.js';
import { initContextBar } from './ui/contextbar.js';
import { initOpRunner, replayOps } from './core/oprunner.js';
import { initModals } from './ui/modals.js';
import { initToolHandlers } from './ui/toolhandlers.js';
import { initHelp, showHelp } from './ui/help.js';
import { initGallery } from './ui/gallery.js';
import { initJpegRotate } from './ui/jpegrotate.js';
import { initLayersPanel } from './ui/layerspanel.js';
import { saveSession, loadSession, clearSession } from './core/session.js';
import { openFromHandle, openFromFile } from './core/fs.js';
import { esc } from './core/html.js';
import { flattenLayers } from './core/layers.js';

import { encodePng } from './encode/png.js';
import { encodeJpeg } from './encode/jpeg.js';
import { encodeWebp } from './encode/webp.js';
import { encodeTiff } from './encode/tiff.js';
import { formatOf } from './decode/registry.js';
import { saveDownload, saveOverwrite, saveSidecar } from './core/fs.js';

function tstamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return String(d.getFullYear()).slice(-2) + p(d.getMonth()+1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Feature probe — no UA sniffing
function checkCompat() {
  const required = [
    typeof OffscreenCanvas !== 'undefined',
    typeof createImageBitmap !== 'undefined',
    !!HTMLCanvasElement.prototype.toBlob,
    typeof ResizeObserver !== 'undefined',
    typeof IntersectionObserver !== 'undefined',
  ];
  return required.every(Boolean);
}

function showCompatError() {
  document.getElementById('compat-warning')?.removeAttribute('hidden');
  document.getElementById('shell')?.remove();
  document.getElementById('empty-state')?.remove();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  if (!checkCompat()) { showCompatError(); return; }

  // Inject icons sprite
  const iconSvg = document.getElementById('icon-sprite');
  if (iconSvg) {
    // already inline
  } else {
    const resp = await fetch('./ui/icons.svg').catch(() => null);
    if (resp?.ok) {
      const text = await resp.text();
      const div = document.createElement('div');
      div.innerHTML = text;
      div.style.display = 'none';
      document.body.insertBefore(div, document.body.firstChild);
    }
  }

  loadPrefs();

  initToasts();
  initViewer();
  initRulers();
  initThumbstrip();
  initToolbar();
  initPanels();
  initSelection();
  initBatch();
  initSlideshow();
  initRightSidebar();
  initContextBar();
  initOpRunner();
  initModals();
  initToolHandlers();
  initHelp();
  initGallery();
  initJpegRotate();
  initLayersPanel();

  setupEmptyState();
  setupKeyboard();
  setupDragDrop();
  setupSave();
  setupSession();
  setupWorkspaceNudge();

  on('image:loaded', () => {
    document.getElementById('empty-state')?.classList.add('hidden');
    // Check MP warning
    const mp = (state.image.width * state.image.height) / 1_000_000;
    if (mp > 100) {
      emit('toast', { message: `Large image (${mp.toFixed(0)}MP). Consider resizing first.`, level: 'warn', duration: 6000 });
    } else if (mp > 50) {
      emit('toast', { message: `Large image (${mp.toFixed(0)}MP). May be slow on this device.`, level: 'warn', duration: 4000 });
    }
  });

  on('selection:clear', () => clearSelection());
  on('fit:window', () => fitToWindow());

  on('tool:changed', ({ tool }) => {
    showPanel(tool === 'crop');
    const canvas = document.getElementById('main-canvas');
    if (canvas) {
      const cursors = { crop: 'crosshair', redact: 'crosshair', blur: 'crosshair', pixelate: 'crosshair', text: 'text', arrow: 'crosshair', pencil: 'crosshair', shape: 'crosshair', eyedropper: 'copy' };
      canvas.style.cursor = tool ? (cursors[tool] ?? 'default') : '';
    }
  });

  // FSA fallback banner
  if (!hasFSA) {
    showFallbackBanner();
  }

  updateVersion();
}

function updateVersion() {
  const footer = document.getElementById('app-version');
  if (footer) footer.textContent = 'Slate v2.0.0';
}

// ── Empty state ───────────────────────────────────────────────────────────────

function setupEmptyState() {
  const el = document.getElementById('empty-state');
  if (!el) return;

  el.innerHTML = `
    <div class="dropzone" id="dropzone">
      <div class="dropzone-icon">
        <svg class="icon" style="width:48px;height:48px;opacity:0.4" aria-hidden="true"><use href="#icon-file"/></svg>
      </div>
      <h2>Drop an image to get started</h2>
      <p>Open any image to crop, redact, annotate, and export — nothing leaves your browser.</p>
      <div class="dropzone-actions">
        <button class="btn btn-primary" id="dz-open-file">
          <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-file"/></svg>
          Open File
        </button>
        <button class="btn" id="dz-open-folder">
          <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-folder"/></svg>
          Open Folder
        </button>
        <button class="btn" id="dz-paste">
          <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-clipboard"/></svg>
          Paste
        </button>
      </div>
      <p class="dropzone-hint">Or drop an image anywhere on this page</p>
      ${!hasFSA ? '<p class="dropzone-hint" style="color:var(--warn)">Compatibility mode: folder write-back unavailable. Download only.</p>' : ''}
    </div>
    <div class="footer-pill">
      <span id="app-version">Slate v2.0.0</span>
      <a href="guide/" target="_blank" rel="noopener">📖 Guide</a>
      <a href="https://naklitechie.github.io/">⬅ More Projects</a>
      <a href="https://github.com/NakliTechie/slate" target="_blank" rel="noopener">⌨ Source</a>
    </div>
  `;

  document.getElementById('dz-open-file')?.addEventListener('click', () => hasFSA ? openFileFSA() : openFileFallback());
  document.getElementById('dz-open-folder')?.addEventListener('click', () => openFolderFSA());
  document.getElementById('dz-paste')?.addEventListener('click', () => openFromClipboard());
}

// ── Fallback banner ───────────────────────────────────────────────────────────

function showFallbackBanner() {
  const mainArea = document.getElementById('main-area');
  if (!mainArea) return;
  const banner = document.createElement('div');
  banner.className = 'banner banner-info';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-info"/></svg>
    <span>Running in compatibility mode — files and folders use the browser picker; overwrite save is unavailable.</span>
    <button class="banner-close" aria-label="Dismiss">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-x"/></svg>
    </button>
  `;
  banner.querySelector('.banner-close').addEventListener('click', () => banner.remove());
  mainArea.insertBefore(banner, mainArea.firstChild);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const tag = document.activeElement?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Always-fire shortcuts
    if (e.key === '?' && !inInput) { showHelp(); return; }
    if (meta && e.key === 's') { e.preventDefault(); smartSave(); return; }
    if (meta && e.shiftKey && e.key === 's') { e.preventDefault(); emit('modal:export', null); return; }
    if (meta && e.key === 'o') { e.preventDefault(); hasFSA ? openFileFSA() : openFileFallback(); return; }
    if (meta && e.shiftKey && e.key === 'O') { e.preventDefault(); openFolderFSA(); return; }
    if (meta && e.key === 'z') { e.preventDefault(); emit('history:undo', null); return; }
    if (meta && e.shiftKey && e.key === 'Z') { e.preventDefault(); emit('history:redo', null); return; }

    if (inInput) return;

    // Paste
    if (meta && e.key === 'v') { e.preventDefault(); openFromClipboard(); return; }

    // Zoom
    if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
    if (meta && e.key === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (meta && e.key === '0') { e.preventDefault(); fitToWindow(); return; }
    if (meta && e.key === '1') { e.preventDefault(); zoomTo(1); return; }

    // View
    if (meta && !e.shiftKey && (e.key === 'r' || e.key === 'R') && state.image.original) {
      e.preventDefault();
      const newVal = !state.view.rulers;
      setRulersVisible(newVal);
      document.getElementById('tb-rulers')?.setAttribute('aria-pressed', String(newVal));
      savePrefs();
      return;
    }

    if (!state.image.original) return;

    // T — thumbstrip toggle (unless text tool is focused)
    if (e.key === 't' || e.key === 'T') {
      if (state.activeTool !== 'text') {
        toggleThumbstrip();
        const vis = !document.getElementById('thumbstrip-bar')?.classList.contains('hidden');
        document.getElementById('tb-thumbstrip')?.setAttribute('aria-pressed', String(vis));
        savePrefs();
        return;
      }
    }

    // Shift+T — text tool
    if (e.shiftKey && (e.key === 't' || e.key === 'T')) {
      emit('tool:changed', { tool: 'text' }); return;
    }

    // Tool keys
    if (e.key === 'c' || e.key === 'C') { emit('tool:activate', { tool: 'crop' }); return; }
    if (e.key === 'r' || e.key === 'R') { emit('tool:activate', { tool: 'redact' }); return; }
    if (e.key === 'b' || e.key === 'B') { emit('tool:activate', { tool: 'blur' }); return; }
    if (e.key === 'a' || e.key === 'A') { emit('tool:activate', { tool: 'arrow' }); return; }
    if (e.key === 'p' || e.key === 'P') { emit('tool:activate', { tool: 'pencil' }); return; }
    if (e.key === 's' || e.key === 'S') { emit('tool:activate', { tool: 'shape' }); return; }
    if (e.key === 'x' || e.key === 'X') { emit('tool:activate', { tool: 'pixelate' }); return; }
    if (e.key === 'i' || e.key === 'I') { emit('tool:activate', { tool: 'eyedropper' }); return; }

    // F — fullscreen
    if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }

    // Escape
    if (e.key === 'Escape') {
      if (state.view.fullscreen) { toggleFullscreen(); return; }
      if (state.selection.shape) { clearSelection(); return; }
      if (state.activeTool) { state.activeTool = null; emit('tool:changed', { tool: null }); return; }
      return;
    }

    // Enter — commit active selection tool
    if (e.key === 'Enter' && state.selection.shape) {
      const t = state.activeTool;
      if (t === 'crop')     { emit('op:crop',     null); return; }
      if (t === 'redact')   { emit('op:redact',   null); return; }
      if (t === 'blur')     { emit('op:blur',     null); return; }
      if (t === 'pixelate') { emit('op:pixelate', null); return; }
    }

    // Navigation
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (state.activeTool || state.selection.shape) {
        // Nudge selection
        const d = e.key === 'ArrowLeft' ? -1 : 1;
        const big = e.shiftKey ? 10 : 1;
        nudgeSelection(d * big, 0, e.altKey);
      } else {
        if (e.key === 'ArrowLeft') navigatePrev(); else navigateNext();
      }
      e.preventDefault(); return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (state.selection.shape) {
        const d = e.key === 'ArrowUp' ? -1 : 1;
        const big = e.shiftKey ? 10 : 1;
        nudgeSelection(0, d * big, e.altKey);
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'Home') { navigateFirst(); return; }
    if (e.key === 'End') { navigateLast(); return; }
    if (e.key === 'PageUp') { navigateSkip(-10); return; }
    if (e.key === 'PageDown') { navigateSkip(10); return; }

    // Select all / deselect
    if (meta && e.key === 'a') { e.preventDefault(); selectAll(); return; }
    if (meta && e.key === 'd') { e.preventDefault(); clearSelection(); return; }
  });
}

// ── Drag and drop ─────────────────────────────────────────────────────────────

function setupDragDrop() {
  const app = document.getElementById('app');
  const dropzone = () => document.getElementById('dropzone');

  app.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropzone()?.classList.add('drag-over');
  });

  app.addEventListener('dragleave', (e) => {
    if (!app.contains(e.relatedTarget)) {
      dropzone()?.classList.remove('drag-over');
    }
  });

  app.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone()?.classList.remove('drag-over');
    await handleDrop(e.dataTransfer);
  });
}

// ── Save ──────────────────────────────────────────────────────────────────────

function setupSave() {
  on('save:request', async (payload) => {
    if (!state.image.working) return;
    await doSave(payload?.dialog);
  });
}

async function doSave(showDialog = false) {
  const { export: exp, image, session } = state;
  const entry = session.files[session.currentIndex];
  const baseName = entry?.name?.replace(/\.[^.]+$/, '') ?? 'image';

  // Encode
  const keepExif = !exp.stripExif && exp.format === 'jpeg';
  const exifRaw  = keepExif ? (image.exif?.raw ?? null) : null;

  // Flatten visible layers onto a copy of the working canvas before encode
  const flat = flattenLayers(image.working);

  let blob;
  try {
    if (exp.format === 'png') blob = await encodePng(flat);
    else if (exp.format === 'jpeg') blob = await encodeJpeg(flat, exp.quality, exifRaw);
    else if (exp.format === 'tiff') blob = await encodeTiff(flat);
    else blob = await encodeWebp(flat, exp.quality);
  } catch (err) {
    emit('error', { message: `Save failed: ${err.message}` });
    return;
  }

  const ext = exp.format === 'jpeg' ? 'jpg' : exp.format === 'tiff' ? 'tif' : exp.format;
  const filename = `${baseName}-${tstamp()}.${ext}`;

  try {
    if (exp.saveMode === 'overwrite' && entry?.handle) {
      // Overwriting reuses the original filename, so the bytes we write must
      // match the container the name claims. Saving a HEIC (or TIFF, RAW, PSD…)
      // as PNG through this path would leave PNG data behind a .heic extension.
      const srcFmt = formatOf(entry.file ?? entry);
      if (srcFmt !== 'unknown' && srcFmt !== exp.format) {
        emit('error', { message: `Cannot overwrite ${entry.name} with ${exp.format.toUpperCase()} — that would leave ${exp.format.toUpperCase()} data under a .${srcFmt} name. Save to a folder or download instead.` });
        return;
      }
      const confirmed = await confirmDialog('This replaces the original file. Undo history will be lost on next open.');
      if (!confirmed) return;
      await saveOverwrite(blob);
      emit('toast', { message: 'File overwritten.', level: 'ok' });
    } else if (exp.saveMode === 'sidecar' && session.folderHandle) {
      const saved = await saveSidecar(blob, ext);
      emit('toast', { message: `Saved as ${saved}`, level: 'ok' });
    } else {
      await saveDownload(blob, filename);
      emit('toast', { message: `Downloaded ${filename}`, level: 'ok' });
    }
    clearSession();
    emit('save:complete', null);
  } catch (err) {
    emit('error', { message: `Save failed: ${err.message}` });
  }
}

// ── Session save / restore ─────────────────────────────────────────────────────

function setupSession() {
  on('history:changed', () => {
    const entry = state.session.files[state.session.currentIndex];
    if (!entry) return;
    const ops = state.history._ops.slice(0, state.history.pointer + 1);
    if (entry.handle) {
      // FSA file: store handle — no pixel data needed, re-reads from disk on restore
      saveSession({ type: 'fsa', handle: entry.handle, name: entry.name, format: state.image.format, ops });
    } else if (entry.file) {
      // Drag-drop / clipboard / fallback picker: store the File blob itself in IDB
      saveSession({ type: 'file', file: entry.file, name: entry.name, format: state.image.format, ops });
    }
  });

  on('image:loaded', () => {
    if (state.session.source !== 'restore') clearSession();
  });

  checkSession();
}

async function checkSession() {
  const saved = await loadSession();
  if (!saved?.ops?.length) return;
  if (saved.type === 'fsa' && !saved.handle) return;
  if (saved.type === 'file' && !saved.file) return;

  const mainArea = document.getElementById('main-area');
  if (!mainArea) return;

  const count = saved.ops.length;
  const banner = document.createElement('div');
  banner.id = 'session-banner';
  banner.className = 'banner banner-info';
  banner.innerHTML = `
    <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-info"/></svg>
    <span>Resume editing <strong>${esc(saved.name)}</strong>? (${count} edit${count !== 1 ? 's' : ''})</span>
    <button class="btn btn-primary" id="session-resume" style="margin-left:auto;padding:2px 10px;font-size:12px">Resume</button>
    <button class="btn" id="session-discard" style="padding:2px 10px;font-size:12px">Discard</button>
  `;
  mainArea.insertBefore(banner, mainArea.firstChild);

  document.getElementById('session-resume').addEventListener('click', async () => {
    banner.remove();
    // Register the replay listener BEFORE opening. openFromHandle emits
    // 'image:loaded' during its await; if we subscribed after, we'd miss it
    // and the ops would never replay.
    if (saved.ops.length) {
      once('image:loaded', async () => {
        try { await replayOps(saved.ops); }
        catch (err) { emit('error', { message: `Could not restore edits: ${err.message}` }); }
      });
    }
    try {
      if (saved.type === 'fsa') {
        await openFromHandle(saved.handle);
      } else {
        await openFromFile(saved.file);
      }
    } catch { /* error toast already shown */ }
  });

  document.getElementById('session-discard').addEventListener('click', () => {
    banner.remove();
    clearSession();
  });
}

async function confirmDialog(message) {
  return new Promise((resolve) => {
    let dialog = document.getElementById('dialog-confirm');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'dialog-confirm';
      dialog.innerHTML = `
        <div class="modal-header"><h2>Confirm</h2></div>
        <p id="confirm-msg"></p>
        <div class="modal-footer">
          <button class="btn" id="confirm-cancel">Cancel</button>
          <button class="btn btn-danger" id="confirm-ok">Confirm</button>
        </div>
      `;
      document.body.appendChild(dialog);
    }
    dialog.querySelector('#confirm-msg').textContent = message;
    dialog.querySelector('#confirm-cancel').onclick = () => { dialog.close(); resolve(false); };
    dialog.querySelector('#confirm-ok').onclick = () => { dialog.close(); resolve(true); };
    dialog.showModal();
  });
}

// ── Smart save ────────────────────────────────────────────────────────────────

async function smartSave() {
  if (!state.image.working) return;
  const { session } = state;
  const entry = session.files[session.currentIndex];

  if (session.folderHandle) {
    // Workspace folder set → sidecar save directly, no dialog
    state.export.saveMode = 'sidecar';
    await doSave(false);
  } else if (entry?.handle) {
    // Opened via FSA file picker → overwrite
    state.export.saveMode = 'overwrite';
    await doSave(false);
  } else {
    // No known target → open export modal so user can choose
    emit('modal:export', null);
  }
}

// ── Workspace nudge ───────────────────────────────────────────────────────────

function setupWorkspaceNudge() {
  const NON_FSA = new Set(['picker', 'dragdrop', 'paste']);
  on('image:loaded', () => {
    document.getElementById('workspace-nudge')?.remove();
    if (!NON_FSA.has(state.session.source)) return;
    if (state.session.folderHandle) return;
    showWorkspaceNudge();
  });
}

function showWorkspaceNudge() {
  if (document.getElementById('workspace-nudge')) return;

  const nudge = document.createElement('div');
  nudge.id = 'workspace-nudge';
  nudge.className = 'workspace-nudge';
  nudge.setAttribute('role', 'status');

  if (hasDirPicker) {
    nudge.innerHTML = `
      <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-folder"/></svg>
      <span>Pick a save folder to preserve your work across sessions.</span>
      <button class="btn btn-primary" id="workspace-nudge-pick" style="font-size:12px;padding:2px 10px;margin-left:4px">Choose Folder</button>
      <button class="workspace-nudge-close" aria-label="Dismiss">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-x"/></svg>
      </button>
    `;
    nudge.querySelector('#workspace-nudge-pick').addEventListener('click', async () => {
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        state.session.folderHandle = dirHandle;
        nudge.remove();
        emit('toast', { message: 'Save folder set — Ctrl+S will save here.', level: 'ok' });
      } catch (err) {
        if (err.name !== 'AbortError') emit('error', { message: `Could not set folder: ${err.message}` });
      }
    });
  } else {
    nudge.innerHTML = `
      <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-info"/></svg>
      <span>Use Chrome on desktop to enable folder save and session restore.</span>
      <button class="workspace-nudge-close" aria-label="Dismiss">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#icon-x"/></svg>
      </button>
    `;
  }

  nudge.querySelector('.workspace-nudge-close').addEventListener('click', () => nudge.remove());
  document.getElementById('app')?.appendChild(nudge);
}

// ── Start ─────────────────────────────────────────────────────────────────────

function notifyNakliOSReady() {
  // The canonical SDK no-ops standalone, so this is safe outside NakliOS.
  window.naklios?.ready();
}

function start() {
  void boot().then(notifyNakliOSReady);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
