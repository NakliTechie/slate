// OWNER: scan agent. OPFS thumbnail store and worker pool. See docs/architecture.md "Thumbnails".
// export function createThumbs(lib) -> { enqueue(records), url(id), dataUrl(id), remove(ids), clear(), sizeBytes() }
export function createThumbs(lib) {
  return {
    enqueue() {}, async url() { return null; }, async dataUrl() { return null; },
    async remove() {}, async clear() {}, async sizeBytes() { return 0; },
  };
}
