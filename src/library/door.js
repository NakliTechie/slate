// The NakliOS door: registers the library commands (commands.js) with the host, so an
// agent in NakliOS calls the same handlers as the buttons and keys, and follows the host
// theme. Standalone, the SDK no-ops, so this does nothing visible.

import { COMMANDS, runCommand } from './commands.js';

export function initDoor(lib, ui) {
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
