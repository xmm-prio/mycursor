/**
 * Bundles the interception runtime into the single-file payload the installer
 * prepends to Cursor's own bundles.
 *
 * `format: iife` plus `platform: node` makes esbuild emit `require("node:...")`
 * calls, which resolve in the CommonJS module scope the payload is prepended
 * to. That is why the runtime uses static imports rather than a global lookup.
 */

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist'), { recursive: true });

/**
 * Two payloads, because the two hosts have nothing in common beyond the route
 * table: Node processes have `require` and a filesystem, the renderer has
 * neither and takes its configuration from the local server instead.
 */
const bundles = [
  {
    name: 'node runtime',
    entry: join(here, 'src', 'runtime', 'entry.ts'),
    outfile: join(here, 'dist', 'payload.runtime.cjs'),
    platform: 'node',
    target: 'node20',
  },
  {
    name: 'renderer',
    entry: join(here, 'src', 'renderer', 'entry.ts'),
    outfile: join(here, 'dist', 'payload.renderer.js'),
    platform: 'browser',
    target: 'es2022',
  },
];

for (const bundle of bundles) {
  const result = await build({
    entryPoints: [bundle.entry],
    outfile: bundle.outfile,
    bundle: true,
    format: 'iife',
    platform: bundle.platform,
    target: bundle.target,
    // Keep the payload readable: it lands inside a file a user may inspect
    // after a failed install, and its size is irrelevant next to a 40 MB
    // bundle.
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(
    `[interceptor] ${bundle.name} payload bundled: ${bundle.outfile} (${(bytes / 1024).toFixed(1)} KiB)`,
  );
}
