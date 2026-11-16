// OWNER: scan agent. Walks a root and feeds lib.applyScan. See docs/architecture.md "Scan".
// export async function scanRoot(lib, root, { full }) -> Promise<{ added, changed, unchanged, missing, failed }>
export async function scanRoot(lib, root, { full = false } = {}) {
  throw new Error('scan not built yet');
}
