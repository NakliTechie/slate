import { state } from '../core/state.js';
import { on, emit } from '../core/events.js';
import { navigateTo } from '../core/fs.js';
import { decode } from '../decode/registry.js';

const THUMB_SIZE = 128;
let bar;
const thumbCache = new Map(); // index → dataURL

export function initThumbstrip() {
  bar = document.getElementById('thumbstrip-bar');
  on('session:changed', render);
  on('navigate', ({ index }) => setActive(index));
  on('image:loaded', () => setActive(state.session.currentIndex));
}

export function toggleThumbstrip() {
  if (!bar) return;
  const visible = bar.classList.toggle('hidden');
  state._thumbstripVisible = !visible;
  emit('thumbstrip:toggled', { visible: !visible });
}

export function isThumbstripVisible() {
  return bar && !bar.classList.contains('hidden');
}

async function render() {
  if (!bar) return;
  bar.innerHTML = '';
  thumbCache.clear();

  const { files } = state.session;
  if (!files.length) return;

  // Create placeholders immediately
  for (let i = 0; i < files.length; i++) {
    const item = createThumbItem(i, files[i].name);
    bar.appendChild(item);
  }

  // Lazy-generate thumbnails using IntersectionObserver
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const el = entry.target;
        const idx = parseInt(el.dataset.index, 10);
        observer.unobserve(el);
        generateThumb(idx, el);
      }
    }
  }, { root: bar, rootMargin: '0px 200px 0px 200px' });

  for (const item of bar.querySelectorAll('.thumb-item')) {
    observer.observe(item);
  }
}

function createThumbItem(index, name) {
  const item = document.createElement('div');
  item.className = 'thumb-item';
  item.dataset.index = index;
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');
  item.setAttribute('aria-label', name);
  if (index === state.session.currentIndex) item.classList.add('active');

  const loading = document.createElement('div');
  loading.className = 'thumb-loading';
  loading.style.cssText = 'width:100%;height:100%;background:var(--bg-2);';
  item.appendChild(loading);

  const label = document.createElement('div');
  label.className = 'thumb-label';
  label.textContent = name;
  item.appendChild(label);

  item.addEventListener('click', () => navigateTo(index));
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(index); }
  });

  return item;
}

async function generateThumb(index, el) {
  if (thumbCache.has(index)) {
    applyThumb(el, thumbCache.get(index));
    return;
  }

  try {
    const entry = state.session.files[index];
    const file = entry.file ?? (entry.handle ? await entry.handle.getFile() : null);
    if (!file) return;

    const bitmap = await decode(file);
    const canvas = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE);
    const ctx = canvas.getContext('2d');

    const scale = Math.min(THUMB_SIZE / bitmap.width, THUMB_SIZE / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    const x = (THUMB_SIZE - w) / 2;
    const y = (THUMB_SIZE - h) / 2;

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    ctx.drawImage(bitmap, x, y, w, h);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
    const url = URL.createObjectURL(blob);
    thumbCache.set(index, url);
    applyThumb(el, url);
  } catch {
    // leave as grey placeholder
  }
}

function applyThumb(el, url) {
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
  const placeholder = el.querySelector('.thumb-loading');
  if (placeholder) el.removeChild(placeholder);
  el.insertBefore(img, el.firstChild);
}

function setActive(index) {
  if (!bar) return;
  for (const item of bar.querySelectorAll('.thumb-item')) {
    item.classList.toggle('active', parseInt(item.dataset.index, 10) === index);
  }
  // Scroll active into view
  const active = bar.querySelector('.thumb-item.active');
  active?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
}
