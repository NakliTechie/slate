// Describe the open image with the NakliOS host model (plan/pending.md, 2026-11-01; spec row X1).
// Shipping LFM3-VL-2B inside Slate would mean a 2B-parameter download and GPU time; the host's
// selected model already reads images when `naklios.capabilities.experimental_aiVision` is true,
// so Slate asks it. Standalone, or without vision, the action is not shown.
//
// The photo goes to whatever model the person selected in NakliOS. When that model is not local
// (`capabilities.aiLocal` false) the dialog says so before anything is sent.

export const DESCRIBE_PROMPT = 'Describe this photo in two or three plain sentences for alt text: what is in it, where, and anything notable. Then on a new line give up to 8 comma-separated keywords, starting with "Keywords:".';
export const MAX_EDGE = 1536;

export function canDescribe(nak = globalThis.window?.naklios) {
  const c = nak?.capabilities;
  return !!(c?.hosted && c.ai && c.experimental_aiVision && nak.ai?.chat?.completions?.create);
}

// Where the photo would go, in words for the dialog.
export function destination(nak = globalThis.window?.naklios) {
  const c = nak?.capabilities ?? {};
  const name = c.aiModelLabel || c.aiModel || 'the selected model';
  return c.aiLocal ? `${name}, on this computer` : `${name}${c.aiProvider ? ` (${c.aiProvider})` : ''}, outside this device`;
}

export function buildRequest(dataUrl, prompt = DESCRIBE_PROMPT) {
  if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) throw new Error('the image must be a base64 data URL');
  return {
    agent: true,
    max_tokens: 300,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
  };
}

// Split the reply into the description and its keywords.
export function parseReply(text) {
  const t = String(text ?? '').trim();
  const m = /\n?\s*Keywords:\s*(.+)$/i.exec(t);
  const keywords = m ? m[1].split(',').map(s => s.trim().replace(/\.$/, '')).filter(Boolean).slice(0, 8) : [];
  return { description: (m ? t.slice(0, m.index) : t).trim(), keywords };
}

// The image scaled to at most MAX_EDGE on the long side, as a JPEG data URL (well under the 8 MB cap).
export async function imageDataUrl(canvas) {
  const s = Math.min(1, MAX_EDGE / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s)), h = Math.max(1, Math.round(canvas.height * s));
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return 'data:image/jpeg;base64,' + btoa(bin);
}

export async function describeImage(canvas, { nak = globalThis.window?.naklios, signal } = {}) {
  if (!canDescribe(nak)) throw new Error('describing needs NakliOS with an image-reading model selected');
  const res = await nak.ai.chat.completions.create({ ...buildRequest(await imageDataUrl(canvas)), signal });
  const text = res?.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('the model returned no description');
  return parseReply(text);
}
