/**
 * The shape of a Cursor installation.
 *
 * Two kinds exist and both need patching for an SSH remote workspace to work:
 * the desktop application on the developer's machine, and the headless server
 * Cursor uploads to a remote host. They share a directory layout — `out/`,
 * `extensions/`, `product.json` — which is why one installer can drive both.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type InstallKind = 'desktop' | 'server';

export interface InstallLayout {
  kind: InstallKind;
  /** Directory containing `product.json`, `out/` and `extensions/`. */
  root: string;
  version: string;
  productJson: string;
  outDir: string;
  extensionsDir: string;
}

export function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** True when `root` looks like a Cursor installation of either kind. */
export function isInstallRoot(root: string): boolean {
  return existsSync(join(root, 'product.json')) && existsSync(join(root, 'out'));
}

export function buildLayout(root: string, kind: InstallKind): InstallLayout {
  return {
    kind,
    root,
    version: readVersion(root),
    productJson: join(root, 'product.json'),
    outDir: join(root, 'out'),
    extensionsDir: join(root, 'extensions'),
  };
}

export function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch };
}
