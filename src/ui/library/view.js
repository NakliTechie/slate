// OWNER: grid agent. The Library mode: sidebar, virtualised grid, scrubber, viewer.
// export function initLibraryView(lib) -> ui { showLibrary(), hideLibrary(), isOpen(), openInEditor(id), select(ids), selection(), focused() }
export function initLibraryView(lib) {
  return { showLibrary() {}, hideLibrary() {}, isOpen() { return false; }, async openInEditor() {}, select() {}, selection() { return []; }, focused() { return null; } };
}
