// The NakliOS door: registers the library and editor commands (commands.js) with the host, so an
// agent in NakliOS calls the same handlers as the buttons and keys, and follows the host
// theme. Standalone, the SDK no-ops, so this does nothing visible.
// Row N6: where the browser offers WebMCP (`navigator.modelContext.registerTool`, an experimental
// proposal), every command is also a page tool named `slate_` plus its name with dots as underscores.
// A destructive tool says it changes files and asks the person with confirm() before it runs.

import { COMMANDS, runCommand } from './commands.js';

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
          if (destructive && !globalThis.confirm?.(`An agent wants to run "${c.label}" in Slate. This changes files. Allow it?`)) {
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
