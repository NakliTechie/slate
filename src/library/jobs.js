// A pausable background job queue. Scan, metadata, thumbnail and (later) ML work
// all run through one of these, so the library stays usable while it fills in,
// and the status bar shows one honest count.
//
//   const q = new JobQueue({ concurrency: 4 });
//   q.onProgress(p => ...);          // { kind, done, failed, total, running, paused, idle }
//   q.add('thumbs', items, async (item, signal) => { ... }, { lane: 'now' });
//   q.pause(); q.resume(); q.cancel('thumbs'); await q.idle();
//
// A job function receives an AbortSignal that fires on cancel. A job that
// throws counts as failed and the queue moves on; it never stops the queue.
// A job whose file was trashed, moved or removed before it ran (it throws a
// NotFoundError) is not a failure: it counts as done.
//
// Lanes: q.add(kind, items, fn, { lane: 'now' | 'background' }). Work the person waits
// for (scan, thumbs, export, import, trash, restore) runs in 'now'; slow indexing
// (ocr, clip, faces, dupes) runs in 'background'. Without a lane, a kind in
// BACKGROUND_KINDS goes to 'background' and every other kind to 'now'. The pump
// always takes 'now' work first, and starts background work only when 'now' is
// empty. Background jobs also never fill the last slot (at most concurrency - 1 of
// them run), so a 'now' job that arrives while OCR or CLIP is busy starts at once
// instead of waiting seconds for a background job to end; a running job is never
// stopped to make room.

export const BACKGROUND_KINDS = new Set(['ocr', 'clip', 'faces', 'dupes', 'rehash']);
const isGone = (err) => err?.name === 'NotFoundError';

export class JobQueue {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = concurrency;
    this.lanes = { now: [], background: [] }; // [{ kind, item, fn }] per lane
    this.running = 0;
    this.runningBackground = 0;
    this.paused = false;
    this.counts = new Map();       // kind -> { done, failed, total }
    this.listeners = new Set();
    this.idleWaiters = [];
    this.controllers = new Map();  // kind -> AbortController
    this.errors = [];              // last 50 { kind, item, message }
  }

  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // Every pending job, 'now' lane first (scan.js reads it to tell whether its items are left).
  get pending() { return [...this.lanes.now, ...this.lanes.background]; }

  add(kind, items, fn, { lane = BACKGROUND_KINDS.has(kind) ? 'background' : 'now' } = {}) {
    if (!this.lanes[lane]) throw new Error(`no job lane ${lane}`);
    if (!this.counts.has(kind)) this.counts.set(kind, { done: 0, failed: 0, total: 0 });
    if (!this.controllers.has(kind)) this.controllers.set(kind, new AbortController());
    const c = this.counts.get(kind), q = this.lanes[lane];
    for (const item of items) { q.push({ kind, item, fn, lane }); c.total++; }
    this._emit(kind);
    this._pump();
  }

  pause() { this.paused = true; this._emit(null); }
  resume() { this.paused = false; this._emit(null); this._pump(); }

  // Drop every pending item of a kind (or all kinds) and abort the running ones.
  cancel(kind = null) {
    for (const lane of Object.keys(this.lanes)) {
      const keep = [];
      for (const j of this.lanes[lane]) {
        if (kind == null || j.kind === kind) this.counts.get(j.kind).total--;
        else keep.push(j);
      }
      this.lanes[lane] = keep;
    }
    for (const [k, ctl] of this.controllers) {
      if (kind == null || k === kind) { ctl.abort(); this.controllers.delete(k); }
    }
    this._emit(kind);
    this._checkIdle();
  }

  // Resolves when nothing is pending or running.
  idle() {
    if (!this.#queued() && !this.running) return Promise.resolve();
    return new Promise(r => this.idleWaiters.push(r));
  }

  status() {
    const kinds = {};
    let done = 0, failed = 0, total = 0;
    for (const [k, c] of this.counts) { kinds[k] = { ...c }; done += c.done; failed += c.failed; total += c.total; }
    const pending = this.#queued();
    return { done, failed, total, running: this.running, pending, paused: this.paused, idle: !pending && !this.running, kinds };
  }

  // Forget finished counts (after the status bar has shown "done").
  reset() {
    if (this.#queued() || this.running) return;
    this.counts.clear();
    this._emit(null);
  }

  #queued() { return this.lanes.now.length + this.lanes.background.length; }

  #next() {
    if (this.lanes.now.length) return this.lanes.now.shift();
    const room = Math.max(1, this.concurrency - 1);
    if (this.lanes.background.length && this.runningBackground < room) return this.lanes.background.shift();
    return null;
  }

  _pump() {
    while (!this.paused && this.running < this.concurrency) {
      const job = this.#next();
      if (!job) break;
      this.running++;
      if (job.lane === 'background') this.runningBackground++;
      const ctl = this.controllers.get(job.kind) ?? new AbortController();
      this.controllers.set(job.kind, ctl);
      Promise.resolve()
        .then(() => job.fn(job.item, ctl.signal))
        .then(() => { this.counts.get(job.kind).done++; },
          (err) => {
            if (ctl.signal.aborted) return;
            const c = this.counts.get(job.kind);
            if (isGone(err)) { c.done++; return; }
            c.failed++;
            this.errors.push({ kind: job.kind, item: job.item?.id ?? job.item?.path ?? String(job.item), message: err?.message ?? String(err) });
            if (this.errors.length > 50) this.errors.shift();
          })
        .finally(() => {
          this.running--;
          if (job.lane === 'background') this.runningBackground--;
          this._emit(job.kind);
          this._pump();
          this._checkIdle();
        });
    }
  }

  _checkIdle() {
    if (this.#queued() || this.running) return;
    const w = this.idleWaiters; this.idleWaiters = [];
    for (const r of w) r();
  }

  _emit(kind) {
    const s = this.status();
    for (const fn of this.listeners) { try { fn({ kind, ...s }); } catch { /* a listener never stops the queue */ } }
  }
}
