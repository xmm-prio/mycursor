/**
 * Keeping `product.json` integrity metadata in step with patched files.
 *
 * Cursor inherits VSCode's checksum list: a base64 SHA-256 of a handful of
 * `out/` files, with base64 padding stripped. A mismatch produces an
 * "installation appears to be corrupt" banner, so a file this toolkit rewrites
 * needs its entry rewritten too.
 *
 * Only keys that already exist are touched. New entries are never added —
 * that would start enforcing integrity on files Cursor deliberately leaves
 * unchecked.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { createBackup, writeFileAtomic } from '../backup/backup-store.js';

export interface ChecksumUpdate {
  key: string;
  previous: string;
  next: string;
}

export interface ChecksumResult {
  updated: ChecksumUpdate[];
  /** Keys that were requested but are not tracked by this installation. */
  untracked: string[];
  /** True when `product.json` was rewritten. */
  changed: boolean;
  backup: string | null;
}

/** VSCode's checksum: base64 SHA-256 with padding removed. */
export function computeChecksum(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('base64').replace(/=+$/, '');
}

interface ProductJson {
  checksums?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Rewrites the checksums for `entries`.
 *
 * `product.json` is reformatted with two-space indentation, matching what
 * Cursor ships, so a diff shows only the checksum lines.
 */
export function updateChecksums(
  productJsonPath: string,
  entries: { key: string; file: string }[],
): ChecksumResult {
  const result: ChecksumResult = { updated: [], untracked: [], changed: false, backup: null };
  if (entries.length === 0 || !existsSync(productJsonPath)) return result;

  let product: ProductJson;
  try {
    product = JSON.parse(readFileSync(productJsonPath, 'utf-8')) as ProductJson;
  } catch (error) {
    throw new Error(`product.json is not readable JSON: ${(error as Error).message}`);
  }

  const checksums = product.checksums;
  if (!checksums || typeof checksums !== 'object') {
    result.untracked.push(...entries.map((entry) => entry.key));
    return result;
  }

  for (const entry of entries) {
    if (!(entry.key in checksums)) {
      result.untracked.push(entry.key);
      continue;
    }
    const next = computeChecksum(entry.file);
    const previous = checksums[entry.key] ?? '';
    if (previous === next) continue;
    checksums[entry.key] = next;
    result.updated.push({ key: entry.key, previous, next });
  }

  if (result.updated.length === 0) return result;

  const backup = createBackup(productJsonPath);
  result.backup = backup.backup;
  writeFileAtomic(productJsonPath, `${JSON.stringify(product, null, 2)}\n`);
  result.changed = true;
  return result;
}

/**
 * Reports which tracked checksums currently disagree with their files.
 *
 * Cursor ships with at least one stale entry of its own, so a mismatch is not
 * by itself evidence that this toolkit is installed; `doctor` presents it as
 * information rather than as a fault.
 */
export function auditChecksums(
  productJsonPath: string,
  resolveFile: (key: string) => string,
): { key: string; matches: boolean }[] {
  if (!existsSync(productJsonPath)) return [];
  let product: ProductJson;
  try {
    product = JSON.parse(readFileSync(productJsonPath, 'utf-8')) as ProductJson;
  } catch {
    return [];
  }
  const checksums = product.checksums ?? {};
  return Object.entries(checksums).map(([key, expected]) => {
    const file = resolveFile(key);
    if (!existsSync(file)) return { key, matches: false };
    return { key, matches: computeChecksum(file) === expected };
  });
}
