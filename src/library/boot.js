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
import { initWatch } from './watch.js';
import { initPlaces } from '../ui/library/places.js';
import { initTextIndex } from './textindex.js';
import { initLocked } from './locked.js';
import { initFaces } from './faces.js';
import { createClip } from './clip.js';
import { initPeople } from '../ui/library/people.js';
import { importTakeoutZips, ZIP_URL } from '../ui/library/import.js';
import { exportFiles } from './export.js';
import { applyICloudCsv } from './icloud.js';
import { buildStacks } from './stacks.js';

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

  lib.services.clip = createClip(lib);
  const ui = initLibraryView(lib);
  lib.services.ui = ui;
  initOrganise(lib, ui);
  initTextIndex(lib);
  initLocked(lib);
  initMemories(lib, ui);
  initXmpWrite(lib);
  initFaces(lib);
  initPeople(lib, ui);
  initImport(lib, ui);
  initDupes(lib, ui);
  initPlaces(lib, ui);
  initDoor(lib, ui);

  await lib.load();
  lib.services.watch = initWatch(lib);

  window.__slateLibrary = {
    lib, ui,
    run: (name, args) => runCommand(lib, name, args, { ui }),
    addRoot: (handle, name) => lib.addRoot({ handle, name }),
    addFiles: (files, name) => lib.addRoot({ handle: null, name, files }),
    // Modules whose own UI needs a folder picker, for live checks that pass OPFS folders instead.
    mods: { importTakeoutZips, ZIP_URL, exportFiles, applyICloudCsv, buildStacks },
  };
  return lib;
}
