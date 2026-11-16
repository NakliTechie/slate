import { state, setImage } from './state.js';
import { emit } from './events.js';
import { decode, isSupportedFile, formatOf } from '../decode/registry.js';
import { parseExif } from '../exif.js';

// Native File System Access pickers cannot be invoked by a cross-origin
// iframe. Slate is embeddable in shells such as NakliOS, so only advertise
// those paths when this document is top-level or shares the top-level origin.
const canUseNativePickers = (() => {
  if (window.self === window.top) return true;
  try { return window.top.location.origin === window.location.origin; }
  catch (_) { return false; }
})();

export const hasFSA = canUseNativePickers && 'showOpenFilePicker' in window;
export const hasDirPicker = canUseNativePickers && 'showDirectoryPicker' in window;

// ── Open paths ────────────────────────────────────────────────────────────────

export async function openFileFSA() {
  if (!hasFSA) { openFileFallback(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Images', accept: { 'image/*': ['.jpg','.jpeg','.png','.webp','.gif','.avif','.svg','.bmp','.heic','.heif','.tif','.tiff','.cr2','.nef','.arw','.dng','.raf','.orf','.jxl','.psd','.tga','.tpic','.dds'] } }],
      multiple: false
    });
    const file = await handle.getFile();
    await loadSingleFile(file, handle, 'fsa');
  } catch (err) {
    if (err.name !== 'AbortError') emit('error', { message: `Could not open file: ${err.message}` });
  }
}

export async function openFolderFSA() {
  if (!hasDirPicker) { openFolderFallback(); return; }
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    await loadFolder(dirHandle);
  } catch (err) {
    if (err.name !== 'AbortError') emit('error', { message: `Could not open folder: ${err.message}` });
  }
}

export function openFolderFallback() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.webkitdirectory = true;
  input.onchange = async () => {
    const files = Array.from(input.files ?? [])
      .filter(isSupportedFile)
      .sort((a, b) =>
        (a.webkitRelativePath || a.name).localeCompare(
          b.webkitRelativePath || b.name,
          undefined,
          { numeric: true },
        ));
    if (files.length) await loadFileList(files, 'picker');
  };
  input.click();
}

export function openFileFallback() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files ?? []).filter(isSupportedFile);
    if (!files.length) return;
    if (files.length === 1) {
      await loadSingleFile(files[0], null, 'picker');
    } else {
      await loadFileList(files, 'picker');
    }
  };
  input.click();
}

export async function openFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find(t => t.startsWith('image/'));
      if (imgType) {
        const blob = await item.getType(imgType);
        const file = new File([blob], `clipboard.${imgType.split('/')[1]}`, { type: imgType });
        await loadSingleFile(file, null, 'paste');
        return;
      }
    }
    emit('toast', { message: 'No image found in clipboard.', level: 'warn' });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      emit('toast', { message: 'Clipboard access denied. Try Ctrl+V / Cmd+V in the viewer.', level: 'warn' });
    } else {
      emit('error', { message: `Clipboard read failed: ${err.message}` });
    }
  }
}

export async function handleDrop(dataTransfer) {
  const items = Array.from(dataTransfer.items ?? []);

  // Check for folder (webkitGetAsEntry)
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      await loadFromDirectoryEntry(entry);
      return;
    }
  }

  // Files
  const files = Array.from(dataTransfer.files ?? []).filter(isSupportedFile);
  if (!files.length) return;
  if (files.length === 1) {
    await loadSingleFile(files[0], null, 'dragdrop');
  } else {
    await loadFileList(files, 'dragdrop');
  }
}

// ── Internal loaders ─────────────────────────────────────────────────────────

// Formats whose decoder is fetched on demand fail for two very different
// reasons — a bad file, or a decoder that never arrived. Blaming the file for a
// network problem sends people off chasing a corrupt HEIC that is perfectly
// fine, so pass the real reason through when the decoder itself is the problem.
function decodeFailureMessage(name, err) {
  const reason = err?.message ?? '';
  if (/decoder|connection|network|failed to fetch|not supported/i.test(reason)) {
    return `Could not open ${name}: ${reason}`;
  }
  return `Could not decode ${name}. The file may be corrupted.`;
}

async function loadSingleFile(file, handle, source) {
  emit('loading:start', { name: file.name });
  try {
    const [bitmap, exif] = await Promise.all([decode(file), parseExif(file)]);
    const format = formatOf(file);

    state.session.source = source;
    state.session.folderHandle = null;
    state.session.files = [{ handle, name: file.name, size: file.size, type: file.type, index: 0, file }];
    state.session.currentIndex = 0;

    setImage(bitmap, format, exif);

    emit('session:changed', state.session);
  } catch (err) {
    emit('error', { message: decodeFailureMessage(file.name, err) });
  } finally {
    emit('loading:end', null);
  }
}

async function loadFileList(files, source) {
  emit('loading:start', { name: files[0].name });
  try {
    state.session.source = source;
    state.session.folderHandle = null;
    state.session.files = files.map((f, i) => ({ handle: null, name: f.name, size: f.size, type: f.type, index: i, file: f }));
    state.session.currentIndex = 0;

    await navigateTo(0);
    emit('session:changed', state.session);
  } catch (err) {
    emit('error', { message: `Could not load files: ${err.message}` });
  } finally {
    emit('loading:end', null);
  }
}

async function loadFolder(dirHandle) {
  emit('loading:start', { name: dirHandle.name });
  try {
    const files = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      const file = await handle.getFile();
      if (isSupportedFile(file)) {
        files.push({ handle, name, size: file.size, type: file.type, index: files.length, file });
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    files.forEach((f, i) => { f.index = i; });

    if (!files.length) {
      emit('toast', { message: 'No supported images found in that folder.', level: 'warn' });
      return;
    }

    state.session.source = 'fsa';
    state.session.folderHandle = dirHandle;
    state.session.files = files;
    state.session.currentIndex = 0;

    await navigateTo(0);
    emit('session:changed', state.session);
  } catch (err) {
    emit('error', { message: `Could not load folder: ${err.message}` });
  } finally {
    emit('loading:end', null);
  }
}

async function loadFromDirectoryEntry(entry) {
  // webkitGetAsEntry fallback (Firefox/non-FSA folder drop)
  const files = [];
  await collectEntries(entry, files);
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) {
    emit('toast', { message: 'No supported images found in that folder.', level: 'warn' });
    return;
  }
  await loadFileList(files, 'dragdrop');
}

async function collectEntries(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    if (isSupportedFile(file)) {
      out.push({ handle: null, name: file.name, size: file.size, type: file.type, index: out.length, file });
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await collectEntries(child, out);
    } while (batch.length > 0);
  }
}

// ── Restore from stored handle (session resume) ───────────────────────────────

export async function openFromFile(file) {
  await loadSingleFile(file, null, 'restore');
}

export async function openFromHandle(handle) {
  try {
    const perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const req = await handle.requestPermission({ mode: 'read' });
      if (req !== 'granted') throw new Error('Permission denied');
    }
    const file = await handle.getFile();
    await loadSingleFile(file, handle, 'restore');
  } catch (err) {
    emit('error', { message: `Could not restore session: ${err.message}` });
    throw err;
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

export async function navigateTo(index) {
  const { files } = state.session;
  if (!files.length) return;
  const i = Math.max(0, Math.min(index, files.length - 1));
  state.session.currentIndex = i;
  const entry = files[i];

  emit('loading:start', { name: entry.name });
  try {
    // Re-fetch File if needed (FSA handles need re-read for freshness)
    const file = entry.file ?? (entry.handle ? await entry.handle.getFile() : null);
    if (!file) throw new Error('Cannot read file');
    entry.file = file; // cache

    const [bitmap, exif] = await Promise.all([decode(file), parseExif(file)]);
    const format = formatOf(file);
    setImage(bitmap, format, exif);
    emit('navigate', { index: i, total: files.length, name: entry.name });
  } catch (err) {
    emit('error', { message: decodeFailureMessage(entry.name, err) });
  } finally {
    emit('loading:end', null);
  }
}

export async function navigateNext() {
  const { files, currentIndex } = state.session;
  if (!files.length) return;
  await navigateTo((currentIndex + 1) % files.length);
}

export async function navigatePrev() {
  const { files, currentIndex } = state.session;
  if (!files.length) return;
  await navigateTo((currentIndex - 1 + files.length) % files.length);
}

export async function navigateFirst() { await navigateTo(0); }
export async function navigateLast() { await navigateTo(state.session.files.length - 1); }
export async function navigateSkip(n) { await navigateTo(state.session.currentIndex + n); }

// ── Save paths ────────────────────────────────────────────────────────────────

export async function saveDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function saveOverwrite(blob) {
  const entry = state.session.files[state.session.currentIndex];
  if (!entry?.handle) throw new Error('No file handle for overwrite');
  const writable = await entry.handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function tstamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return String(d.getFullYear()).slice(-2) + p(d.getMonth()+1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

export async function saveSidecar(blob, ext) {
  const dir = state.session.folderHandle;
  if (!dir) throw new Error('No folder handle for sidecar save');
  const entry = state.session.files[state.session.currentIndex];
  const base = entry.name.replace(/\.[^.]+$/, '');

  let name = `${base}-${tstamp()}.${ext}`;
  let counter = 1;
  while (true) {
    try {
      await dir.getFileHandle(name);
      name = `${base}-${tstamp()}-${counter}.${ext}`;
      counter++;
    } catch {
      break;
    }
  }

  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return name;
}
