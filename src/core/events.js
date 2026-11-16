const _bus = new Map();

export function on(type, fn) {
  if (!_bus.has(type)) _bus.set(type, new Set());
  _bus.get(type).add(fn);
}

export function off(type, fn) {
  _bus.get(type)?.delete(fn);
}

export function once(type, fn) {
  const wrapper = (data) => { fn(data); off(type, wrapper); };
  on(type, wrapper);
}

export function emit(type, data) {
  _bus.get(type)?.forEach(fn => fn(data));
}
