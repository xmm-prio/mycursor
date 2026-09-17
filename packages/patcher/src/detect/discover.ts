/**
 * Finding the files that need a payload, by what they contain.
 *
 * A hardcoded file list is the main reason installers of this kind break on
 * every Cursor release: the moment a bundle is renamed or a transport moves to
 * a different process, the list is wrong and the tool either fails loudly or,
 * worse, silently patches nothing. Discovery here works from content
 * fingerprints — the API hostnames and ConnectRPC service names Cursor's own
 * code contains — so a file that carries model traffic is found wherever it
 * lives.
 *
 * Two runtimes are distinguished, because they need different payloads. Node
 * processes get the full interception runtime. The renderer is a browser
 * context with no `require` and no filesystem, so it gets a payload that
 * rewrites `fetch` and `WebSocket` and takes its configuration from the local
 * server instead of from disk.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { InstallLayout } from './layout.js';

export type TargetRuntime = 'node' | 'renderer';

export interface DiscoveredTarget {
  /** Stable identifier, used in logs, backups and the install manifest. */
  id: string;
  file: string;
  runtime: TargetRuntime;
  /** Short label the payload reports itself as. */
  processLabel: string;
  /** Key in `product.json.checksums`, when the file is covered by one. */
  checksumKey: string | null;
  sizeBytes: number;
}

/**
 * Content fingerprints. A file needs at least one to be considered, which is
 * what keeps the discovery from prepending a payload to unrelated bundles.
 */
const FINGERPRINTS = [
  'api2.cursor.sh',
  'api3.cursor.sh',
  'api4.cursor.sh',
  'gcpp.cursor.sh',
  'api.playground.cursor.sh',
  'aiserver.v1.',
  'agent.v1.AgentService',
];

/** Cheap pre-filter: a bundle carrying model traffic is never tiny. */
const MIN_SIZE_BYTES = 64 * 1024;

function hasFingerprint(source: string): boolean {
  return FINGERPRINTS.some((needle) => source.includes(needle));
}

function readIfInteresting(file: string): string | null {
  try {
    if (statSync(file).size < MIN_SIZE_BYTES) return null;
    const source = readFileSync(file, 'utf-8');
    return hasFingerprint(source) ? source : null;
  } catch {
    return null;
  }
}

function listFiles(directory: string, extension = '.js'): string[] {
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

function listDirectories(directory: string): string[] {
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

/**
 * `product.json` records checksums relative to `out/`, with forward slashes.
 * Returning the key lets the caller keep integrity metadata in step with a
 * patched file.
 */
function checksumKeyFor(layout: InstallLayout, file: string): string | null {
  const rel = relative(layout.outDir, file);
  if (rel.startsWith('..')) return null;
  return rel.split(sep).join('/');
}

/** Renderer bundles: `workbench.<variant>.main.js` under `out/vs/workbench`. */
function discoverRendererTargets(layout: InstallLayout): DiscoveredTarget[] {
  const workbench = join(layout.outDir, 'vs', 'workbench');
  const targets: DiscoveredTarget[] = [];
  for (const file of listFiles(workbench)) {
    const name = file.split(sep).pop() ?? '';
    if (!/^workbench\..*main\.js$/.test(name)) continue;
    const source = readIfInteresting(file);
    if (!source) continue;
    const variant = name.replace(/^workbench\./, '').replace(/\.main\.js$/, '');
    targets.push({
      id: `renderer:${variant}`,
      file,
      runtime: 'renderer',
      processLabel: `renderer-${variant}`,
      checksumKey: checksumKeyFor(layout, file),
      sizeBytes: statSync(file).size,
    });
  }
  return targets;
}

/**
 * Node processes shipped inside `out/`: the extension host, the utility
 * process that hosts Cursor's local services, and — on a server install — the
 * remote server entry point.
 */
function discoverOutNodeTargets(layout: InstallLayout): DiscoveredTarget[] {
  const searchDirs = [
    join(layout.outDir, 'vs', 'workbench', 'api', 'node'),
    join(layout.outDir, 'vs', 'server', 'node'),
    ...listDirectories(join(layout.outDir, 'vs', 'code', 'electron-utility')),
    ...listDirectories(join(layout.outDir, 'vs', 'code', 'node')),
  ];

  const targets: DiscoveredTarget[] = [];
  for (const directory of searchDirs) {
    for (const file of listFiles(directory)) {
      const source = readIfInteresting(file);
      if (!source) continue;
      const name = (file.split(sep).pop() ?? '').replace(/\.js$/, '');
      targets.push({
        id: `node:${name}`,
        file,
        runtime: 'node',
        processLabel: name,
        checksumKey: checksumKeyFor(layout, file),
        sizeBytes: statSync(file).size,
      });
    }
  }
  return targets;
}

/**
 * Built-in extensions whose entry bundle carries model traffic — the agent
 * host among them, which is the process a subagent run goes through.
 *
 * Only the declared entry point is considered. Patching lazily loaded chunks
 * is unnecessary: the payload installs itself into the process, and the entry
 * point always runs first.
 */
function discoverExtensionTargets(layout: InstallLayout): DiscoveredTarget[] {
  const targets: DiscoveredTarget[] = [];
  for (const directory of listDirectories(layout.extensionsDir)) {
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: { name?: string; main?: string; browser?: string; extensionKind?: string[] };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }

    // A `ui`-only extension runs in the renderer and has no Node entry point.
    if (manifest.extensionKind?.length === 1 && manifest.extensionKind[0] === 'ui') continue;

    const entry = manifest.main;
    if (!entry) continue;
    const file = join(directory, entry.replace(/^\.\//, ''));
    const source = readIfInteresting(file);
    if (!source) continue;

    const name = manifest.name ?? (directory.split(sep).pop() ?? 'extension');
    targets.push({
      id: `extension:${name}`,
      file,
      runtime: 'node',
      processLabel: name,
      checksumKey: null,
      sizeBytes: statSync(file).size,
    });
  }
  return targets;
}

export interface DiscoveryResult {
  layout: InstallLayout;
  targets: DiscoveredTarget[];
}

export function discoverTargets(layout: InstallLayout): DiscoveryResult {
  const targets = [
    ...discoverRendererTargets(layout),
    ...discoverOutNodeTargets(layout),
    ...discoverExtensionTargets(layout),
  ];
  // Stable order keeps install logs and the manifest comparable between runs.
  targets.sort((a, b) => a.id.localeCompare(b.id));
  return { layout, targets };
}

export { FINGERPRINTS };
