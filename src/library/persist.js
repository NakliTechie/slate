// OWNER: organise agent. Reads and writes .slate-library.json. See docs/architecture.md "Library file".
// export function createPersist(store) -> { load(root), save(root, libfile), canWrite(root) }
export function createPersist(store) {
  return { async load() { return null; }, async save() {}, canWrite() { return false; } };
}
