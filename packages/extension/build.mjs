/**
 * Bundles the extension and the server launcher it supervises.
 *
 * Two outputs rather than one: the extension runs in Cursor's extension host,
 * while the server runs as a child process. Bundling the launcher alongside
 * means a packaged extension can start the server without the repository being
 * present.
 */

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist', 'server'), { recursive: true });

const targets = [
  {
    name: 'extension',
    entry: join(here, 'src', 'extension.ts'),
    outfile: join(here, 'dist', 'extension.cjs'),
    // `vscode` is provided by the host at runtime and must never be bundled.
    external: ['vscode'],
  },
  {
    name: 'server launcher',
    entry: join(here, '..', 'server', 'src', 'launch.ts'),
    outfile: join(here, 'dist', 'server', 'launch.js'),
    external: [],
  },
];

for (const target of targets) {
  const result = await build({
    entryPoints: [target.entry],
    outfile: target.outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: target.external,
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`[extension] ${target.name} bundled: ${target.outfile} (${(bytes / 1024).toFixed(1)} KiB)`);
}

// The panel's HTML, stylesheet and script are loaded as webview resources at
// runtime, so they are copied rather than bundled.
console.log(`[extension] panel assets are served from media/ (${readdirSync(join(here, 'media')).join(', ')})`);

