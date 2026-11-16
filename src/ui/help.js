import { on } from '../core/events.js';
import { showTour, showLibraryTour, setAsideEditorTour, TOUR_KEY } from './tour.js';
import { LICENCES } from '../library/licences.js';
import { esc } from '../core/html.js';

const SEEN_KEY = 'slate.v1.help-seen';

export function initHelp() {
  on('help:show', showHelp);
  // The library view emits this when the Library opens; the first time, a short library tour runs.
  // The editor tour points at editor controls, so it never sits on top of the Library.
  on('library:shown', () => { setAsideEditorTour(); setTimeout(() => showLibraryTour(), 300); });
  on('library:hidden', () => { if (!localStorage.getItem(TOUR_KEY)) setTimeout(() => showTour(), 300); });

  if (!localStorage.getItem(TOUR_KEY)) {
    // Defer until the toolbar and empty-state actions are real tour targets.
    setTimeout(() => { if (!document.getElementById('app')?.classList.contains('library-open')) showTour(); }, 500);
  }
}

export function showHelp() {
  let dlg = document.getElementById('modal-help');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'modal-help';
    dlg.className = 'help-dialog';
    document.body.appendChild(dlg);
  }

  dlg.innerHTML = `
    <div class="help-header">
      <h2>Slate — Help</h2>
      <button class="btn-icon help-close" aria-label="Close">
        <svg class="icon" aria-hidden="true"><use href="#icon-x"/></svg>
      </button>
    </div>
    <div class="help-tabs" role="tablist">
      ${['Welcome','Quick Start','Tools','Saving','Shortcuts','Library','Licences'].map((t,i) =>
        `<button class="help-tab-btn${i===0?' active':''}" role="tab" data-tab="${i}">${t}</button>`
      ).join('')}
    </div>
    <div class="help-body">
      ${panel(0, welcome())}
      ${panel(1, quickStart())}
      ${panel(2, tools() + adjustments())}
      ${panel(3, saving())}
      ${panel(4, shortcuts())}
      ${panel(5, library())}
      ${panel(6, licences())}
    </div>
    <div class="help-footer">
      <a class="help-footer-link" href="guide/" target="_blank" rel="noopener">Open full guide &rarr;</a>
      <button class="btn" id="help-start-tour" type="button">Take the quick tour</button>
    </div>
  `;

  dlg.querySelector('.help-close').addEventListener('click', () => closeHelp(dlg));
  dlg.querySelector('#help-start-tour').addEventListener('click', () => {
    closeHelp(dlg);
    setTimeout(() => showTour({ force: true }), 0);
  });
  dlg.addEventListener('click', e => { if (e.target === dlg) closeHelp(dlg); });

  dlg.querySelectorAll('.help-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      dlg.querySelectorAll('.help-tab-btn').forEach(b => b.classList.remove('active'));
      dlg.querySelectorAll('.help-panel').forEach(p => p.hidden = true);
      btn.classList.add('active');
      dlg.querySelector(`.help-panel[data-tab="${btn.dataset.tab}"]`).hidden = false;
    });
  });

  dlg.showModal();
}

function closeHelp(dlg) {
  dlg.close();
  localStorage.setItem(SEEN_KEY, '1');
}

function panel(i, html) {
  return `<div class="help-panel" data-tab="${i}"${i > 0 ? ' hidden' : ''}>${html}</div>`;
}

function section(title, html) {
  return `<div class="help-section"><h3>${title}</h3>${html}</div>`;
}

function row(label, desc) {
  return `<div class="help-row"><span class="help-label">${label}</span><span class="help-desc">${desc}</span></div>`;
}

function kbd(k) { return `<kbd>${k}</kbd>`; }

// ── Tab content ───────────────────────────────────────────────────────────────

function welcome() {
  return `
    <div class="help-welcome">
      <div class="help-welcome-logo">
        <svg class="icon" style="width:40px;height:40px;opacity:0.9" aria-hidden="true"><use href="#icon-file"/></svg>
      </div>
      <h2 class="help-welcome-title">Slate</h2>
      <p class="help-welcome-tagline">An image editor that runs entirely in your browser.<br>No install. No upload. Nothing leaves your device.</p>
    </div>
    <div class="help-welcome-features">
      <div class="help-feature-item">
        <span class="help-feature-icon">✂️</span>
        <div><strong>Crop, Redact & Blur</strong><br>Draw a selection and trim, black-box, or blur a region — great for screenshots and privacy.</div>
      </div>
      <div class="help-feature-item">
        <span class="help-feature-icon">✏️</span>
        <div><strong>Annotate</strong><br>Add text labels and arrows directly on the image.</div>
      </div>
      <div class="help-feature-item">
        <span class="help-feature-icon">🎨</span>
        <div><strong>Adjust & Enhance</strong><br>Brightness, contrast, saturation, sharpen, rotate, flip, and resize.</div>
      </div>
      <div class="help-feature-item">
        <span class="help-feature-icon">📁</span>
        <div><strong>Album mode</strong><br>Open a folder to browse images with arrow keys and thumbnails — like a lightweight viewer.</div>
      </div>
    </div>
    <p class="help-welcome-hint">Use the tabs above to explore features, or press <kbd>?</kbd> any time to return here.</p>
  `;
}

function quickStart() {
  return `
    ${section('Opening images', `
      ${row('Open file', `${kbd('Ctrl+O')} or click <strong>Open File</strong>`)}
      ${row('Open folder', `${kbd('Ctrl+Shift+O')} — loads all images as an album (Chrome/Edge only)`)}
      ${row('Drag & drop', 'Drop a file or folder anywhere on the window')}
      ${row('Clipboard', `${kbd('Ctrl+V')} or click <strong>Paste</strong> — pastes a screenshot or copied image`)}
    `)}
    ${section('Navigating a folder', `
      ${row('Next / Prev', `${kbd('←')} ${kbd('→')} arrow keys`)}
      ${row('First / Last', `${kbd('Home')} / ${kbd('End')}`)}
      ${row('Jump 10', `${kbd('PgUp')} / ${kbd('PgDn')}`)}
      ${row('Thumbnails', `${kbd('T')} toggles the strip at the bottom — click any thumb to jump`)}
    `)}
    ${section('Viewing', `
      ${row('Zoom in/out', `${kbd('Ctrl++')} / ${kbd('Ctrl+−')} or mouse wheel`)}
      ${row('Fit to window', `${kbd('Ctrl+0')} or double-click canvas`)}
      ${row('100%', kbd('Ctrl+1'))}
      ${row('Pan', `${kbd('Space')}+drag or middle-mouse drag`)}
      ${row('Fullscreen', kbd('F'))}
    `)}
    ${section('Session restore', `
      <p class="help-p">Slate remembers your last open file and edits. On next visit it will offer to resume where you left off.</p>
      <p class="help-p">Pick a <strong>workspace folder</strong> (shown after opening a dragged/pasted file) to save sidecar files alongside your originals.</p>
    `)}
  `;
}

function tools() {
  return `
    ${section('Selection tools', `
      <p class="help-p">Draw a rectangle on the canvas, then commit with ${kbd('Enter')} or the floating bar, or cancel with ${kbd('Esc')}.</p>
      ${row('Crop', `${kbd('C')} — trims the image to the selection`)}
      ${row('Redact', `${kbd('R')} — fills the selection with a solid black box`)}
      ${row('Blur', `${kbd('B')} — blurs the selection; drag the <strong>Blur</strong> slider in the bar to set strength (2–40 px)`)}
      ${row('Pixelate', `${kbd('X')} — mosaics the selection into average-coloured blocks; drag the <strong>Pixel size</strong> slider in the bar (2–60 px)`)}
    `)}
    ${section('Annotation tools (layers)', `
      ${row('Text', `${kbd('Shift+T')} — click anywhere on the image to place a text label`)}
      ${row('Arrow', `${kbd('A')} — drag to draw an annotation arrow`)}
      ${row('Freehand', `${kbd('P')} — drag to draw a smoothed pencil stroke`)}
      ${row('Shapes', `${kbd('S')} — drag to draw a rectangle, oval, or line. Mode picker + colour + thickness + fill toggle in the bar`)}
      <p class="help-p">Text, arrows, pencil strokes and shapes become <strong>editable layers</strong>. A floating Layers panel at the top-right of the canvas lists every layer with move-up/down, show/hide and delete controls. Layers flatten into the image automatically on Save or when you apply a transform (crop, rotate, flip, resize, sharpen, adjust).</p>
      <p class="help-p">When any drawing tool is active, the floating bar shows that tool's <strong>brush settings</strong> — colour, thickness, and tool-specific options — so you can adjust before drawing or between strokes.</p>
    `)}
    ${section('Colour picker', `
      ${row('Eyedropper', `${kbd('I')} — click any pixel on the image to copy its colour. The hex value goes to your clipboard and applies as the colour for pencil, arrow, shape, and text. After picking, the eyedropper switches back to whichever drawing tool you came from.`)}
      <p class="help-p">Each colour you use is remembered as a small <strong>recent-swatch</strong> shown next to every colour picker (drawing tools' floating bar and the text modal). The list holds the last 8 colours, persists across reloads, and clicking a swatch sets the active tool's colour instantly.</p>
    `)}
    ${section('Tips', `
      <p class="help-p">After drawing a selection you can nudge it with arrow keys (${kbd('Shift')}+arrow = 10 px). ${kbd('Ctrl+A')} selects the whole image. ${kbd('Ctrl+D')} deselects.</p>
      <p class="help-p">Right-click or long-press a tool in the <strong>Recent</strong> sidebar to star it as a favourite.</p>
    `)}
  `;
}

function adjustments() {
  return `
    ${section('Transform', `
      ${row('Rotate', 'Rotate 90° clockwise or counter-clockwise')}
      ${row('Flip', 'Flip horizontally or vertically')}
      ${row('Straighten', 'Fine rotation (−45° to +45°) — canvas expands to prevent cropping')}
    `)}
    ${section('Colour & tone', `
      ${row('Exposure / Contrast', 'Exposure in stops (±2) and a contrast curve about middle grey, in linear light')}
      ${row('Saturation', 'Scales colour in Oklab, so hue and lightness hold')}
      ${row('Look (LUT)', 'Load a .cube file in Adjust and set its strength')}
      ${row('Sharpen', 'Unsharp-mask sharpening (0.1×–5×)')}
      ${row('Background blur', 'Click what stays sharp; areas nearer or farther get more blur, set by Strength. A depth model runs on this device and downloads once (about 27 to 50 MB).')}
    `)}
    ${section('Geometry', `
      ${row('Resize', 'Set exact output dimensions; aspect lock keeps proportions')}
    `)}
    ${section('Text', `
      ${row('Extract text', 'Reads printed English text from the image, on this device; copy it or save it as .txt. The recogniser downloads once (about 5 MB).')}
    `)}
    ${section('Undo / Redo', `
      ${row('Undo', kbd('Ctrl+Z'))}
      ${row('Redo', kbd('Ctrl+Shift+Z'))}
      <p class="help-p">History goes back 50 steps. It resets when you open a new image.</p>
    `)}
  `;
}

function saving() {
  return `
    ${section('Quick save', `
      ${row(kbd('Ctrl+S'), 'Smart save — uses the best available target (see below)')}
      ${row(kbd('Ctrl+Shift+S'), 'Always opens the Export dialog to choose format and destination')}
    `)}
    ${section('Save destinations', `
      ${row('Download', 'Saves a copy to your Downloads folder — works everywhere')}
      ${row('Overwrite', 'Replaces the original file in place (only available when opened via file picker)')}
      ${row('Workspace folder', 'Saves a timestamped sidecar file next to your original (e.g. <em>photo-260424143005.jpg</em>)')}
    `)}
    ${section('Workspace folder', `
      <p class="help-p">After opening a dragged or pasted image, Slate suggests picking a folder. Once set, ${kbd('Ctrl+S')} saves there automatically — no dialog needed.</p>
      <p class="help-p">The workspace folder also enables session restore across refreshes.</p>
    `)}
    ${section('Formats', `
      ${row('Read', 'JPG, PNG, WebP, GIF (first frame), AVIF, SVG, BMP, HEIC/HEIF, TIFF, JPEG-XL, PSD, TGA, DDS, and RAW (CR2, NEF, ARW, DNG, RAF, ORF) via the embedded preview')}
      ${row('Write', 'PNG, JPEG, WebP, TIFF')}
      <p class="help-p">Anything Slate can read, it can convert. Open a HEIC from your phone, edit it, and export it as PNG, JPEG, WebP or TIFF like any other image. The decoders for the less common formats (HEIC, TIFF, JPEG-XL, PSD) download the first time you open one, so that first open needs a connection and takes a moment.</p>
      <p class="help-p">Saving <em>back</em> to those formats isn't possible — no browser can encode them, and Slate does everything on your device. That also means <strong>Overwrite</strong> is unavailable for them: overwriting reuses the original filename, so writing PNG data into a <em>.heic</em> file would leave you with a file that no longer matches its own name. Use <strong>Download</strong> or <strong>Workspace folder</strong> instead, and you'll get a properly named new file.</p>
    `)}
    ${section('EXIF metadata', `
      <p class="help-p">EXIF is stripped by default when exporting (the canvas re-encode removes it). Uncheck <strong>Strip EXIF</strong> in the Export dialog to re-embed the original EXIF into JPEG exports.</p>
      <p class="help-p">If the source image has GPS coordinates, a warning appears in the Image Info panel (ⓘ button).</p>
    `)}
    ${section('Batch conversion', `
      <p class="help-p">Batch (convert / resize / rotate / flip / rename across a folder) reads every format the editor does. With <strong>Convert</strong> switched on, pick the output format explicitly.</p>
      <p class="help-p">With <strong>Convert</strong> switched off, files keep their own format — except read-only ones like HEIC or RAW, which have no encoder to write back to. Those are saved as lossless PNG instead, and the dry run tells you how many before anything is written.</p>
    `)}
  `;
}

function shortcuts() {
  const rows = [
    ['File', [
      ['Ctrl+O', 'Open file'],
      ['Ctrl+Shift+O', 'Open folder'],
      ['Ctrl+V', 'Paste from clipboard'],
      ['Ctrl+Shift+V', 'Apply edits copied from Image Info'],
      ['Ctrl+S', 'Smart save'],
      ['Ctrl+Shift+S', 'Export dialog'],
    ]],
    ['Edit', [
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Shift+Z', 'Redo'],
      ['Ctrl+A', 'Select all'],
      ['Ctrl+D', 'Deselect'],
      ['Enter', 'Apply crop / redact / blur'],
      ['Esc', 'Cancel / close tool'],
    ]],
    ['Tools', [
      ['C', 'Crop'],
      ['R', 'Redact'],
      ['B', 'Blur'],
      ['X', 'Pixelate'],
      ['A', 'Arrow'],
      ['P', 'Freehand'],
      ['S', 'Shapes'],
      ['I', 'Eyedropper'],
      ['Shift+T', 'Text'],
    ]],
    ['View', [
      ['Ctrl+0', 'Fit to window'],
      ['Ctrl+1', '100%'],
      ['Ctrl++', 'Zoom in'],
      ['Ctrl+−', 'Zoom out'],
      ['F', 'Fullscreen'],
      ['Ctrl+R', 'Toggle rulers'],
      ['T', 'Toggle thumbnails'],
      ['Space+drag', 'Pan canvas'],
    ]],
    ['Navigation', [
      ['← →', 'Prev / next image'],
      ['Home / End', 'First / last image'],
      ['PgUp / PgDn', 'Skip 10'],
    ]],
    ['Other', [
      ['?', 'This help'],
    ]],
  ];

  return rows.map(([group, items]) => `
    <div class="help-section">
      <h3>${group}</h3>
      <table class="shortcut-table">
        ${items.map(([k, d]) => `<tr><td>${kbd(k)}</td><td>${d}</td></tr>`).join('')}
      </table>
    </div>
  `).join('');
}

function library() {
  const keys = [
    ['Ctrl+L', 'Open the Library'],
    ['← → ↑ ↓', 'Move between photos'],
    ['Enter', 'Open the photo full size'],
    ['Escape', 'Go back (from the photo, the editor or a selection)'],
    ['Space', 'Select or deselect the photo'],
    ['/', 'Search'],
    ['F', 'Favourite'],
    ['0 to 5', 'Rate (0 clears the rating)'],
    ['P', 'Flag as pick'],
    ['X', 'Flag as reject'],
    ['U', 'Clear the flag'],
    ['H', 'Hide or show again'],
    ['T', 'Tag'],
    ['Delete', 'Move to trash'],
    ['E', 'Open in the editor'],
    ['Shift + key', 'Apply F, 0 to 5, P, X, U, H, T or Delete and move to the next photo'],
  ];
  return `
    ${section('What the Library does', `
      <p class="help-p">The Library shows every photo and video in the folders you add, sorted by the date they were taken. Slate reads your files where they are and uploads nothing.</p>
      ${row('Library file', 'Favourites, ratings, flags, tags and albums are saved in a <code>.slate-library.json</code> file at the top of each added folder, so they travel with the folder. If Slate cannot write to the folder, it keeps them in this browser and offers the file as a download.')}
      ${row('Trash', 'Move to trash puts the file in a <code>.slate-trash</code> folder inside its library folder. Restore puts it back. Only Empty trash deletes files, and it asks first.')}
      ${row('Index and thumbnails', 'The photo index lives in this browser (IndexedDB) and the thumbnails in its private storage (OPFS). Rebuild index recreates both from your folders.')}
      ${row('Batch and gallery', 'Select photos, then use Batch or Contact sheet / Gallery to run them on just the selection.')}
    `)}
    <div class="help-section">
      <h3>Library keys</h3>
      <table class="shortcut-table">
        ${keys.map(([k, d]) => `<tr><td>${kbd(k)}</td><td>${d}</td></tr>`).join('')}
      </table>
    </div>
  `;
}

function licences() {
  const bundled = LICENCES.filter(l => l.loaded === 'bundled');
  const fetched = LICENCES.filter(l => l.loaded !== 'bundled');
  const line = l => row(`${esc(l.name)} ${esc(l.version)}`, `${esc(l.use)}. ${esc(l.licence)} licence. <a href="${esc(l.source)}" target="_blank" rel="noopener">Source</a>`);
  return `
    ${section('Built into Slate', `
      <p class="help-p">These packages are part of this file. Their licence texts follow.</p>
      ${bundled.map(l => line(l) + `<details class="help-licence"><summary>${esc(l.name)} licence</summary><pre class="help-p" style="white-space:pre-wrap;font-size:11px">${esc(l.text)}</pre></details>`).join('')}
    `)}
    ${section('Fetched on first use', `
      <p class="help-p">These load at a pinned version the first time a feature needs them: decoders from esm.sh when you open such a file; the CLIP, face and map libraries from jsDelivr and their models from Hugging Face only after you turn that feature on; place data from Slate's own site. Each carries its own licence.</p>
      ${fetched.map(line).join('')}
    `)}
  `;
}
