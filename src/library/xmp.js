// OWNER: organise agent. Parses XMP sidecars. See docs/architecture.md "XMP".
// export function parseXmp(text) -> { tags: string[], rating: number, label: string|null, time: number|null, lat: number|null, lon: number|null }
// export function sidecarNames(name) -> [fullName.xmp, stem.xmp]
export function parseXmp(text) {
  return { tags: [], rating: 0, label: null, time: null, lat: null, lon: null };
}
export function sidecarNames(name) {
  const i = name.lastIndexOf('.');
  return [name + '.xmp', (i < 0 ? name : name.slice(0, i)) + '.xmp'];
}
