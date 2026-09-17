/**
 * Builds a shadow copy of a real Cursor installation.
 *
 * The point is to run the installer against the actual bundles Cursor ships —
 * 3.14.7's real 38 MB renderer, its real agent host — without going near the
 * application the developer is using. Only the files the patcher touches are
 * copied, plus the manifests discovery reads, which keeps a 524 MB install down
 * to about 100 MB of shadow.
 *
 * Copying the live files rather than synthesising fixtures is deliberate: a
 * fixture cannot tell you that discovery still finds the agent host after an
 * upgrade, and it cannot reproduce oddities like the third-party renderer
 * injection this machine already has.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Files whose content the patcher needs, relative to the install root. */
const CONTENT_FILES = [
  'product.json',
  'package.json',
  'out/vs/workbench/workbench.desktop.main.js',
  'out/vs/workbench/workbench.glass.main.js',
  'out/vs/workbench/api/node/extensionHostProcess.js',
  'out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js',
];

/** Extensions whose entry bundle is copied in full. */
const CONTENT_EXTENSIONS = ['cursor-agent-host'];

export function buildShadowTree({ source, destination }) {
  if (!existsSync(join(source, 'product.json'))) {
    throw new Error(`not a Cursor installation: ${source}`);
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  const copied = [];
  const copy = (rel) => {
    const from = join(source, rel);
    if (!existsSync(from)) return false;
    const to = join(destination, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push({ rel, bytes: statSync(to).size });
    return true;
  };

  for (const rel of CONTENT_FILES) copy(rel);

  for (const name of CONTENT_EXTENSIONS) {
    const manifestRel = `extensions/${name}/package.json`;
    if (!copy(manifestRel)) continue;
    const manifest = JSON.parse(readFileSync(join(source, manifestRel), 'utf-8'));
    const entry = (manifest.main ?? '').replace(/^\.\//, '');
    if (entry) copy(`extensions/${name}/${entry}`);
  }

  // Every other extension manifest is copied without its bundle, so discovery
  // has to walk the same number of candidates it would in a real install and
  // still reject the ones that carry no model traffic.
  const extensionsDir = join(source, 'extensions');
  let manifestsOnly = 0;
  if (existsSync(extensionsDir)) {
    for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || CONTENT_EXTENSIONS.includes(entry.name)) continue;
      if (copy(`extensions/${entry.name}/package.json`)) manifestsOnly += 1;
    }
  }

  const totalBytes = copied.reduce((sum, item) => sum + item.bytes, 0);
  return { destination, copied, manifestsOnly, totalBytes };
}

/**
 * Builds a shadow tree shaped like a headless server installation.
 *
 * An SSH remote workspace runs `~/.cursor-server/cli/servers/<version>/server`,
 * which shares the desktop layout — `out/`, `extensions/`, `product.json` — and
 * is therefore meant to be handled by exactly the same locator and patcher.
 * "Meant to" is the part worth checking: the remote path is the one that
 * cannot be exercised on a developer machine by accident, so it is the one
 * most likely to rot.
 */
export function buildServerShadowTree({ source, destination }) {
  const serverRoot = join(destination, 'cli', 'servers', 'Stable-verification', 'server');
  const result = buildShadowTree({ source, destination: serverRoot });
  return { ...result, serverRoot, cursorServerHome: destination };
}

/** SHA-256 of every file in the shadow tree, for byte-exact restore checks. */
export function hashTree(root) {
  const hashes = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else hashes.set(path, createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(root);
  return hashes;
}
