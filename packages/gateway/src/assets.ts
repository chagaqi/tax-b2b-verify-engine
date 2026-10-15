import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export interface ShellAssets {
  pipedriveModalHtml: string;
  pipedriveModalJs: string;
  mondayItemViewHtml: string;
  mondayItemViewJs: string;
}

/**
 * Development loader: reads the shells' static files from the workspace.
 * The production build (build.mjs) replaces this module with inlined strings,
 * so dist/server.mjs needs no files next to it.
 */
export function loadShellAssets(): ShellAssets {
  const require = createRequire(import.meta.url);
  const read = (spec: string) => readFileSync(require.resolve(spec), 'utf8');
  return {
    pipedriveModalHtml: read('@tbve/shell-pipedrive/public/modal.html'),
    pipedriveModalJs: read('@tbve/shell-pipedrive/public/modal.js'),
    mondayItemViewHtml: read('@tbve/shell-monday/public/item-view.html'),
    mondayItemViewJs: read('@tbve/shell-monday/public/item-view.js'),
  };
}
