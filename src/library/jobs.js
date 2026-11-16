// A pausable background job queue. Scan, metadata, thumbnail and (later) ML work
// all run through one of these, so the library stays usable while it fills in,
// and the status bar shows one honest count.
//
//   const q = new JobQueue({ concurrency: 4 });
//   q.onProgress(p => ...);          // { kind, done, failed, total, running, paused, idle }
//   q.add('thumbs', items, async (item, signal) => { ... });
//   q.pause(); q.resume(); q.cancel('thumbs'); await q.idle();
//
// A job function receives an AbortSignal that fires on cancel. A job that
// throws counts as failed and the queue moves on; it never stops the queue.

export class JobQueue {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = concurrency;
    this.pending = [];             // [{ kind, item, fn }]
    this.running = 0;
    this.paused = false;
    this.counts = new Map();       // kind -> { done, failed, total }
    this.listeners = new Set();
    this.idleWaiters = [];
    this.controllers = new Map();  // kind -> AbortController
    this.errors = [];              // last 50 { kind, item, message }
  }

  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  add(kind, items, fn) {
    if (!this.counts.has(kind)) this.counts.set(kind, { done: 0, failed: 0, total: 0 });
    if (!this.controllers.has(kind)) this.controllers.set(kind, new AbortController());
    const c = this.counts.get(kind);
    for (const item of items) { this.pending.push({ kind, item, fn }); c.total++; }
    this._emit(kind);
    this._pump();
  }

  pause() { this.paused = true; this._emit(null); }
  resume() { this.paused = false; this._emit(null); this._pump(); }

  // Drop every pending item of a kind (or all kinds) and abort the running ones.
  cancel(kind = null) {
    const keep = [];
    for (const j of this.pending) {
      if (kind == null || j.kind === kind) this.counts.get(j.kind).total--;
      else keep.push(j);
    }
    this.pending = keep;
    for (const [k, ctl] of this.controllers) {
      if (kind == null || k === kind) { ctl.abort(); this.controllers.delete(k); }
    }
    this._emit(kind);
    this._checkIdle();
  }

  // Resolves when nothing is pending or running.
  idle() {
    if (!this.pending.length && !this.running) return Promise.resolve();
    return new Promise(r => this.idleWaiters.push(r));
  }

  status() {
    const kinds = {};
    let done = 0, failed = 0, total = 0;
    for (const [k, c] of this.counts) { kinds[k] = { ...c }; done += c.done; failed += c.failed; total += c.total; }
    return { done, failed, total, running: this.running, pending: this.pending.length, paused: this.paused, idle: !this.pending.length && !this.running, kinds };
  }

  // Forget finished counts (after the status bar has shown "done").
  reset() {
    if (this.pending.length || this.running) return;
    this.counts.clear();
    this._emit(null);
  }

  _pump() {
    while (!this.paused && this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      this.running++;
      const ctl = this.controllers.get(job.kind) ?? new AbortController();
      this.controllers.set(job.kind, ctl);
      Promise.resolve()
        .then(() => job.fn(job.item, ctl.signal))
        .then(() => { this.counts.get(job.kind).done++; },
          (err) => {
            if (ctl.signal.aborted) return;
            this.counts.get(job.kind).failed++;
            this.errors.push({ kind: job.kind, item: job.item?.id ?? job.item?.path ?? String(job.item), message: err?.message ?? String(err) });
            if (this.errors.length > 50) this.errors.shift();
          })
        .finally(() => {
          this.running--;
          this._emit(job.kind);
          this._pump();
          this._checkIdle();
        });
    }
  }

  _checkIdle() {
    if (this.pending.length || this.running) return;
    const w = this.idleWaiters; this.idleWaiters = [];
    for (const r of w) r();
  }

  _emit(kind) {
    const s = this.status();
    for (const fn of this.listeners) { try { fn({ kind, ...s }); } catch { /* a listener never stops the queue */ } }
  }
}
