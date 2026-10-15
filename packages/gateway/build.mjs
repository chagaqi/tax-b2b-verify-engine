// Bundles the gateway (core-api, Hono, pdf-lib, zod, shell assets) into one file: dist/server.mjs.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Replace src/assets.ts with a module that inlines the shell HTML/JS. */
const inlineShellAssets = {
  name: 'inline-shell-assets',
  setup(b) {
    b.onLoad({ filter: /[\\/]gateway[\\/]src[\\/]assets\.ts$/ }, () => {
      const read = (spec) => readFileSync(require.resolve(spec), 'utf8');
      const assets = {
        pipedriveModalHtml: read('@tbve/shell-pipedrive/public/modal.html'),
        pipedriveModalJs: read('@tbve/shell-pipedrive/public/modal.js'),
        mondayItemViewHtml: read('@tbve/shell-monday/public/item-view.html'),
        mondayItemViewJs: read('@tbve/shell-monday/public/item-view.js'),
      };
      return { loader: 'js', contents: `const ASSETS = ${JSON.stringify(assets)};\nexport function loadShellAssets() { return ASSETS; }\n` };
    });
  },
};

export async function bundle(outfile = resolve(here, 'dist/server.mjs')) {
  await build({
    entryPoints: [resolve(here, 'src/server.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    charset: 'utf8',
    plugins: [inlineShellAssets],
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __tbveCreateRequire } from 'node:module'; const require = __tbveCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await bundle(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`built ${out}`);
}
