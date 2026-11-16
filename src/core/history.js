const MAX_STEPS = 50;
const SNAPSHOT_INTERVAL = 10;

export class History {
  constructor() {
    this._ops = [];      // [{ op, params, snapshotAfter? }]
    this._snaps = [];    // [{ pointer, imageData, width, height }]
    this._pointer = -1;  // -1 = original state
  }

  push(op, params) {
    // truncate any redo branch
    this._ops = this._ops.slice(0, this._pointer + 1);
    this._snaps = this._snaps.filter(s => s.pointer <= this._pointer);

    this._ops.push({ op, params });

    if (this._ops.length > MAX_STEPS) {
      const removed = this._ops.length - MAX_STEPS;
      this._ops = this._ops.slice(removed);
      this._snaps = this._snaps
        .filter(s => s.pointer >= removed)
        .map(s => ({ ...s, pointer: s.pointer - removed }));
      this._pointer = Math.max(-1, this._pointer - removed);
    }

    this._pointer = this._ops.length - 1;
    return this._pointer;
  }

  saveSnapshot(pointer, imageData, width, height, layers = []) {
    if (pointer % SNAPSHOT_INTERVAL !== 0) return;
    this._snaps = this._snaps.filter(s => s.pointer !== pointer);
    this._snaps.push({ pointer, imageData, width, height, layers });
  }

  // Returns { pointer, imageData, width, height } of the nearest snapshot at or before targetPointer,
  // plus the ops that need to be replayed after it.
  getReplayPlan(targetPointer) {
    const snap = this._snaps
      .filter(s => s.pointer <= targetPointer)
      .sort((a, b) => b.pointer - a.pointer)[0] ?? null;

    const startPointer = snap ? snap.pointer : -1;
    const ops = this._ops.slice(startPointer + 1, targetPointer + 1);
    return { snap, ops };
  }

  canUndo() { return this._pointer >= 0; }
  canRedo() { return this._pointer < this._ops.length - 1; }

  stepBack() {
    if (!this.canUndo()) return false;
    this._pointer--;
    return true;
  }

  stepForward() {
    if (!this.canRedo()) return false;
    this._pointer++;
    return true;
  }

  get pointer() { return this._pointer; }
  // The ops that made the current image (for the embedded edit list).
  opsToPointer() { return this._ops.slice(0, this._pointer + 1).map(({ op, params }) => ({ op, params })); }
  get size() { return this._ops.length; }

  clear() {
    this._ops = [];
    this._snaps = [];
    this._pointer = -1;
  }
}
