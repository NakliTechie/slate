// Boots the photo library inside Slate. Called once from app.js after the editor is up.
// Wires the core (library.js) to its browser services and its UI, then loads the index.
//
// Test seam (live checks only drive this; the folder picker cannot be driven):
//   window.__slateLibrary = { lib, ui, run(name, args), addRoot(handle, name), addFiles(files, name) }
// `addRoot` takes any FileSystemDirectoryHandle, including an OPFS directory made by the test.

import { Library } from './library.js';
import { idbStore, memoryStore } from './store.js';
import { runCommand } from './commands.js';
import { scanRoot } from './scan.js';
import { createThumbs } from './thumbs.js';
import { createPersist } from './persist.js';
import { createTrash } from './trash.js';
import { initDoor } from './door.js';
import { initLibraryView } from '../ui/library/view.js';
import { initOrganise } from '../ui/library/organise.js';
import { initMemories } from './memories.js';
import { initXmpWrite } from './xmpwrite.js';
import { initImport } from '../ui/library/import.js';
import { initDupes } from '../ui/library/dupes.js';
import { importTakeoutZips, ZIP_URL } from '../ui/library/import.js';
import { exportFiles } from './export.js';

let _lib = null;
export function getLibrary() { return _lib; }

export async function initLibrary() {
  let store;
  try { store = await idbStore(); }
  catch (e) { console.warn('[slate library] IndexedDB unavailable, index kept in memory only', e); store = memoryStore(); }

  const lib = new Library({ store });
  lib.services.scanRoot = scanRoot;
  lib.services.thumbs = createThumbs(lib);
  lib.services.persist = createPersist(store);
  lib.services.trash = createTrash();
  _lib = lib;

  const ui = initLibraryView(lib);
  lib.services.ui = ui;
  initOrganise(lib, ui);
  initMemories(lib, ui);
  initXmpWrite(lib);
  initImport(lib, ui);
  initDupes(lib, ui);
  initDoor(lib, ui);

  await lib.load();

  window.__slateLibrary = {
    lib, ui,
    run: (name, args) => runCommand(lib, name, args, { ui }),
    addRoot: (handle, name) => lib.addRoot({ handle, name }),
    addFiles: (files, name) => lib.addRoot({ handle: null, name, files }),
    // Modules whose own UI needs a folder picker, for live checks that pass OPFS folders instead.
    mods: { importTakeoutZips, ZIP_URL, exportFiles },
  };
  return lib;
}
