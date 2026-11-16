export const TOUR_KEY = 'slate.v2.tour-complete';
export const LIBRARY_TOUR_KEY = 'slate.v2.library-tour-complete';

const STEPS = [
  {
    target: '.dropzone-actions',
    title: 'Start with an image',
    body: 'Open one file, browse a folder, paste a screenshot, or simply drop an image anywhere. Your pixels stay in this browser.',
  },
  {
    target: '#toolbar',
    title: 'Everything is one click away',
    body: 'File, edit, drawing, transform, view, and batch commands live in the top toolbar. Hover a control to see its keyboard shortcut.',
  },
  {
    target: '#tb-crop',
    title: 'Select, then apply',
    body: 'Crop, redact, blur, and pixelate all begin by drawing a region. Press Enter to apply the pending edit or Escape to cancel it.',
  },
  {
    target: '#right-sidebar',
    title: 'Slate learns your tools',
    body: 'Recently used and favourite tools collect here. Right-click or long-press a recent tool to keep it close.',
  },
  {
    target: '#tb-save',
    title: 'Save on your terms',
    body: 'Ctrl+S uses the best available destination: your chosen workspace folder, the original file, or a private browser download.',
  },
  {
    target: '#tb-help',
    title: 'Help is always here',
    body: 'Press ? for the full guide, shortcuts, and saving details. You can replay this tour from Help whenever you like.',
  },
];

// A short second tour, shown the first time the Library opens (row K3). It is separate so
// the editor tour stays six steps. Targets belong to src/ui/library/view.js.
const LIBRARY_STEPS = [
  {
    target: '.library-sidebar',
    title: 'Your photo library',
    body: 'Timeline, favourites, albums, folders and trash are here. Add a folder to bring its photos in. Slate keeps your choices in a .slate-library.json file inside that folder, and uploads nothing.',
  },
  {
    target: '.library-grid',
    title: 'Cull with the keyboard',
    body: 'Arrows move, Space selects, Enter opens. F favourites, 0 to 5 rate, P picks, X rejects. Hold Shift to apply and move to the next photo. Press ? for every library key.',
  },
];

let layer = null;
let stepIndex = 0;
let previousFocus = null;
let activeSteps = STEPS;
let activeKey = TOUR_KEY;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function currentTarget() {
  return document.querySelector(activeSteps[stepIndex].target)
    || document.getElementById('toolbar')
    || document.body;
}

function targetIsVisible(step) {
  const target = document.querySelector(step.target);
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  const style = getComputedStyle(target);
  return rect.width > 0 && rect.height > 0 &&
    style.display !== 'none' && style.visibility !== 'hidden';
}

function positionTour() {
  if (!layer) return;
  const target = currentTarget();
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const rect = target.getBoundingClientRect();
  const pad = 6;
  const spot = layer.querySelector('.tour-spotlight');
  spot.style.top = Math.max(4, rect.top - pad) + 'px';
  spot.style.left = Math.max(4, rect.left - pad) + 'px';
  spot.style.width = Math.max(24, Math.min(innerWidth - 8, rect.width + pad * 2)) + 'px';
  spot.style.height = Math.max(24, Math.min(innerHeight - 8, rect.height + pad * 2)) + 'px';

  const card = layer.querySelector('.tour-card');
  const cardRect = card.getBoundingClientRect();
  const gap = 18;
  const margin = 12;
  let top;
  let left;
  if (rect.bottom + gap + cardRect.height <= innerHeight - margin) {
    top = rect.bottom + gap;
    left = rect.left + rect.width / 2 - cardRect.width / 2;
  } else if (rect.top - gap - cardRect.height >= margin) {
    top = rect.top - gap - cardRect.height;
    left = rect.left + rect.width / 2 - cardRect.width / 2;
  } else if (rect.left - gap - cardRect.width >= margin) {
    top = rect.top + rect.height / 2 - cardRect.height / 2;
    left = rect.left - gap - cardRect.width;
  } else if (rect.right + gap + cardRect.width <= innerWidth - margin) {
    top = rect.top + rect.height / 2 - cardRect.height / 2;
    left = rect.right + gap;
  } else {
    top = innerHeight - cardRect.height - margin;
    left = innerWidth / 2 - cardRect.width / 2;
  }
  card.style.top = clamp(top, margin, innerHeight - cardRect.height - margin) + 'px';
  card.style.left = clamp(left, margin, innerWidth - cardRect.width - margin) + 'px';
  card.style.visibility = 'visible';
}

function renderStep() {
  if (!layer) return;
  const step = activeSteps[stepIndex];
  layer.querySelector('.tour-progress').textContent =
    'Quick tour · ' + (stepIndex + 1) + ' of ' + activeSteps.length;
  layer.querySelector('.tour-title').textContent = step.title;
  layer.querySelector('.tour-body').textContent = step.body;
  layer.querySelector('.tour-back').disabled = stepIndex === 0;
  layer.querySelector('.tour-next').textContent =
    stepIndex === activeSteps.length - 1 ? 'Finish' : 'Next';
  layer.querySelector('.tour-card').style.visibility = 'hidden';
  requestAnimationFrame(() => {
    positionTour();
    layer && layer.querySelector('.tour-next').focus();
  });
}

function finishTour() {
  try { localStorage.setItem(activeKey, '1'); } catch {}
  closeTour();
}

// Closes the editor tour without recording it as seen, so it runs the next time
// the editor is on screen. Used when the Library opens on top of it.
export function setAsideEditorTour() {
  if (layer && activeKey === TOUR_KEY) closeTour();
}

function closeTour() {
  if (!layer) return;
  const oldLayer = layer;
  layer = null;
  window.removeEventListener('resize', positionTour);
  document.removeEventListener('keydown', handleTourKeydown, true);
  oldLayer.remove();
  if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  previousFocus = null;
}

function handleTourKeydown(event) {
  if (!layer) return;
  // The modal owns every key while open; do not let editor shortcuts also run.
  event.stopPropagation();
  if ((event.key === 'Enter' || event.key === ' ') &&
      event.target instanceof Element &&
      event.target.closest('.tour-actions button')) {
    event.preventDefault();
    event.target.click();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    finishTour();
    return;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (stepIndex < activeSteps.length - 1) { stepIndex++; renderStep(); }
    else finishTour();
    return;
  }
  if (event.key === 'ArrowLeft' && stepIndex > 0) {
    event.preventDefault();
    stepIndex--;
    renderStep();
    return;
  }
  if (event.key !== 'Tab') {
    return;
  }
  const controls = [...layer.querySelectorAll('button:not([disabled])')];
  if (!controls.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function showTour({ force = false } = {}) {
  if (layer || (!force && localStorage.getItem(TOUR_KEY))) return false;
  previousFocus = document.activeElement;
  stepIndex = 0;
  activeKey = TOUR_KEY;
  activeSteps = STEPS.filter(targetIsVisible);
  if (!activeSteps.length) activeSteps = STEPS.slice(1);
  openLayer();
  return true;
}

export function showLibraryTour({ force = false } = {}) {
  let seen = null;
  try { seen = localStorage.getItem(LIBRARY_TOUR_KEY); } catch {}
  if (layer || (!force && seen)) return false;
  previousFocus = document.activeElement;
  stepIndex = 0;
  activeKey = LIBRARY_TOUR_KEY;
  activeSteps = LIBRARY_STEPS.filter(targetIsVisible);
  if (!activeSteps.length) activeSteps = LIBRARY_STEPS;
  openLayer();
  return true;
}

function openLayer() {
  layer = document.createElement('div');
  layer.className = 'tour-layer';
  layer.innerHTML = `
    <div class="tour-spotlight" aria-hidden="true"></div>
    <section class="tour-card" role="dialog" aria-modal="true"
             aria-labelledby="tour-title" aria-describedby="tour-body">
      <div class="tour-progress"></div>
      <h2 class="tour-title" id="tour-title"></h2>
      <p class="tour-body" id="tour-body" aria-live="polite"></p>
      <div class="tour-actions">
        <button class="btn tour-skip" type="button">Skip tour</button>
        <button class="btn tour-back" type="button">Back</button>
        <button class="btn btn-primary tour-next" type="button">Next</button>
      </div>
    </section>`;
  document.body.appendChild(layer);
  layer.querySelector('.tour-skip').addEventListener('click', finishTour);
  layer.querySelector('.tour-back').addEventListener('click', () => {
    if (stepIndex > 0) { stepIndex--; renderStep(); }
  });
  layer.querySelector('.tour-next').addEventListener('click', () => {
    if (stepIndex < activeSteps.length - 1) { stepIndex++; renderStep(); }
    else finishTour();
  });
  window.addEventListener('resize', positionTour);
  document.addEventListener('keydown', handleTourKeydown, true);
  renderStep();
}
