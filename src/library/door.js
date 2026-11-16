// The NakliOS door: registers the library and editor commands (commands.js) with the host, so an
// agent in NakliOS calls the same handlers as the buttons and keys, and follows the host
// theme. Standalone, the SDK no-ops, so this does nothing visible.
// Row N6: where the browser offers WebMCP (`navigator.modelContext.registerTool`, an experimental
// proposal), every command is also a page tool named `slate_` plus its name with dots as underscores.
// A destructive tool says it changes files and asks the person with confirm() before it runs.
// The question names how many photos the call touches and the first few file names
// (confirmText), so "Empty trash" reads differently for 1 file and for 100,000.

import { COMMANDS, runCommand, visible } from './commands.js';

const CONFIRM_NAMES = 3;

// The ids a destructive call touches, or null when it does not name photos.
function idsOf(lib, name, input) {
  if (Array.isArray(input?.ids)) return input.ids;
  if (Array.isArray(input?.moves)) return input.moves.map(m => m?.id);
  if (name === 'trash.empty' && lib.records) return [...lib.records.keys()].filter(id => lib.choice(id).trashed && visible(lib, id));
  return null;
}

export function confirmText(lib, c, input = {}) {
  let what = '';
  const list = idsOf(lib, c.name, input);
  if (list) {
    const names = [];
    for (const id of list) {
      if (names.length === CONFIRM_NAMES) break;
      const r = typeof lib.get === 'function' && visible(lib, id) ? lib.get(id) : null;
      if (r?.name) names.push(r.name);
    }
    const more = list.length - names.length;
    const count = `${list.length.toLocaleString('en-GB')} ${list.length === 1 ? 'photo' : 'photos'}`;
    what = ` on ${count}${names.length ? ` (${names.join(', ')}${more > 0 ? ` and ${more.toLocaleString('en-GB')} more` : ''})` : ''}`;
  } else if (c.name === 'library.undo_files') {
    const reason = lib.undoLog?.get(input?.token)?.reason;
    if (reason) what = ` to undo a ${reason}`;
  } else if (c.name === 'album.delete') {
    const al = lib.albums?.get(input?.album);
    if (al) what = ` on the album "${al.name}"`;
  }
  return `An agent wants to run "${c.label}" in Slate${what}. This changes files. Allow it?`;
}

export const webmcpName = name => `slate_${name.replace(/\./g, '_')}`;

export function registerWebMcp(lib, ui) {
  const mc = globalThis.navigator?.modelContext;
  if (typeof mc?.registerTool !== 'function') return 0;
  let n = 0;
  for (const c of COMMANDS) {
    const destructive = c.scope === 'destructive';
    try {
      mc.registerTool({
        name: webmcpName(c.name),
        description: destructive ? `${c.description} This changes files, so Slate asks the person to confirm first.` : c.description,
        inputSchema: c.input,
        execute: async (input) => {
          if (destructive && !globalThis.confirm?.(confirmText(lib, c, input ?? {}))) {
            return { content: [{ type: 'text', text: 'The person declined; nothing changed.' }], isError: true };
          }
          try {
            const out = await runCommand(lib, c.name, input ?? {}, { ui });
            return { content: [{ type: 'text', text: JSON.stringify(out ?? null) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e.message }], isError: true };
          }
        },
      });
      n++;
    } catch (e) {
      console.warn(`[slate] WebMCP registration of ${c.name} failed`, e);
    }
  }
  return n;
}

export function initDoor(lib, ui) {
  registerWebMcp(lib, ui);
  const sdk = window.naklios;
  if (!sdk) return;

  try {
    const list = COMMANDS.map(c => ({
      name: c.name, description: c.description, scope: c.scope, input: c.input,
      handler: input => runCommand(lib, c.name, input ?? {}, { ui }),
    }));
    Promise.resolve(sdk.experimental_commands?.register(list))
      .catch(e => console.warn('[slate library] command registration failed', e));
  } catch (e) {
    console.warn('[slate library] command registration failed', e);
  }

  // Row N4: follow the host theme. The host sends a mood; only "light" maps to Slate's light theme.
  if (sdk.capabilities?.hosted) {
    sdk.theme?.onChange?.(t => {
      const next = t?.mood === 'light' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.querySelector('#tb-theme .icon use')?.setAttribute('href', `#icon-${next === 'light' ? 'moon' : 'sun'}`);
    });
  }
}
