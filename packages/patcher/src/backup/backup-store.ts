/**
 * Backups and the install manifest.
 *
 * Two independent records are kept because they fail in different ways:
 *
 *  - a sibling `.mycursor-bak` file next to each patched file, which survives
 *    even if the configuration directory is deleted;
 *  - a manifest in the configuration directory, which survives a Cursor
 *    upgrade that replaces the patched files and their siblings.
 *
 * Uninstall consults both, so a partial loss of either still leaves a route
 * back to an unmodified installation.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { withRetry } from './fs-retry.js';

export const BACKUP_SUFFIX = '.mycursor-bak';
export const MANIFEST_FILE_NAME = 'install-manifest.json';

export interface ManifestEntry {
  targetId: string;
  file: string;
  backup: string;
  runtime: 'node' | 'renderer';
  /** Size of the pristine file, used to detect a Cursor upgrade. */
  originalSize: number;
  patchedAt: string;
}

export interface InstallManifest {
  $schemaVersion: 1;
  toolkitVersion: string;
  installs: {
    root: string;
    kind: string;
    cursorVersion: string;
    /** `product.json` backup, present when checksums were rewritten. */
    productBackup: string | null;
    entries: ManifestEntry[];
  }[];
}

export function backupPathFor(file: string): string {
  return `${file}${BACKUP_SUFFIX}`;
}

/**
 * Copies `file` aside once.
 *
 * Re-running install must not overwrite an existing backup with already-patched
 * content — that would destroy the only pristine copy — so an existing backup
 * is always left alone.
 */
export function createBackup(file: string): { created: boolean; backup: string } {
  const backup = backupPathFor(file);
  if (existsSync(backup)) return { created: false, backup };
  withRetry(() => copyFileSync(file, backup));
  return { created: true, backup };
}

/** Restores a file from its backup and removes the backup. */
export function restoreBackup(file: string): boolean {
  const backup = backupPathFor(file);
  if (!existsSync(backup)) return false;
  withRetry(() => copyFileSync(backup, file));
  rmSync(backup, { force: true });
  return true;
}

export function hasBackup(file: string): boolean {
  return existsSync(backupPathFor(file));
}

export function readManifest(configRoot: string): InstallManifest | null {
  const path = join(configRoot, MANIFEST_FILE_NAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as InstallManifest;
  } catch {
    return null;
  }
}

/** Writes the manifest atomically so an interrupted install leaves it readable. */
export function writeManifest(configRoot: string, manifest: InstallManifest): string {
  mkdirSync(configRoot, { recursive: true });
  const path = join(configRoot, MANIFEST_FILE_NAME);
  const temp = join(configRoot, `.${MANIFEST_FILE_NAME}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
  return path;
}

export function removeManifest(configRoot: string): void {
  rmSync(join(configRoot, MANIFEST_FILE_NAME), { force: true });
}

/**
 * Writes a file atomically within its own directory, preserving the mode.
 *
 * The rename is retried: on Windows it fails while anything else holds the
 * target open, which for a freshly written multi-megabyte bundle is routinely
 * a virus scanner and resolves within milliseconds. The temporary file is
 * cleaned up if the rename never succeeds, so a failed write does not leave
 * debris next to Cursor's own files.
 */
export function writeFileAtomic(file: string, contents: string): void {
  const temp = join(dirname(file), `.${process.pid}-${Date.now()}.mycursor-tmp`);
  let mode: number | undefined;
  try {
    mode = statSync(file).mode;
  } catch {
    mode = undefined;
  }
  writeFileSync(temp, contents, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
  try {
    withRetry(() => renameSync(temp, file));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
