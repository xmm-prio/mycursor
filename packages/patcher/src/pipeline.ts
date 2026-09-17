/**
 * Install, inspect and uninstall as one pipeline: plan, apply, verify, roll back.
 *
 * Two decisions shape everything here.
 *
 * **Prepend only.** Every patch is the same operation — put a self-contained
 * payload in front of a file and change nothing else. No expression is
 * rewritten, no minified identifier is located, no AST is edited. That is what
 * makes the installer survive a Cursor release: the payload does not care what
 * the file it precedes contains, so a reshuffled bundle cannot invalidate it.
 * Capabilities that would otherwise need bundle surgery — refusing the agent
 * WebSocket, waiting for the local server before the first request — are
 * handled at runtime by the interceptor and the route table instead.
 *
 * **Byte-exact verification.** Because a patch is a prepend, a patched file
 * must equal payload plus original, byte for byte. That is a far stronger
 * check than re-parsing, and it is what lets `apply` roll back with confidence
 * when a single file misbehaves.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MyCursorConfig } from '@mycursor/core/config';
import {
  buildPayload,
  buildRendererPayload,
  hasPayload,
  hasStalePayload,
  stripPayload,
} from '@mycursor/interceptor';

import {
  backupPathFor,
  createBackup,
  hasBackup,
  restoreBackup,
  writeFileAtomic,
  type InstallManifest,
  type ManifestEntry,
} from './backup/backup-store.js';
import { discoverTargets, type DiscoveredTarget } from './detect/discover.js';
import type { InstallLayout } from './detect/layout.js';
import { updateChecksums, type ChecksumResult } from './integrity/product-checksums.js';

export type PlanAction =
  /** Not patched yet. */
  | 'patch'
  /** Patched by an older payload; replace it. */
  | 'refresh'
  /** Already carries the current payload. */
  | 'current';

export interface PlanEntry {
  target: DiscoveredTarget;
  action: PlanAction;
  reason: string;
}

export interface PatchPlan {
  layout: InstallLayout;
  entries: PlanEntry[];
  /** True when nothing needs writing. */
  satisfied: boolean;
}

export interface PatchOptions {
  config: MyCursorConfig;
  /** Written into the Node payload; lets a sandbox run redirect config lookup. */
  configPath?: string;
  /** Emits progress lines. */
  log?: (message: string) => void;
}

/** Per-target guard key, so `doctor` can see which payloads a process loaded. */
export function guardMarkerFor(target: DiscoveredTarget): string {
  return `__mycursorGuard_${target.id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

export function planInstall(layout: InstallLayout): PatchPlan {
  const { targets } = discoverTargets(layout);
  const entries: PlanEntry[] = targets.map((target) => {
    const source = readFileSync(target.file, 'utf-8');
    const guard = guardMarkerFor(target);
    if (!hasPayload(source, guard)) {
      return { target, action: 'patch' as const, reason: 'no payload present' };
    }
    if (hasStalePayload(source, guard)) {
      return { target, action: 'refresh' as const, reason: 'payload is from an older build' };
    }
    return { target, action: 'current' as const, reason: 'payload is current' };
  });

  return {
    layout,
    entries,
    satisfied: entries.every((entry) => entry.action === 'current'),
  };
}

export interface ApplyResult {
  layout: InstallLayout;
  patched: PlanEntry[];
  skipped: PlanEntry[];
  checksums: ChecksumResult;
  manifestEntries: ManifestEntry[];
  /** Set when the run was rolled back; the installation is unmodified. */
  rolledBack: { failedTarget: string; error: string } | null;
}

/**
 * Applies a plan, restoring every file it touched if any step fails.
 *
 * The rollback is what makes a half-applied install impossible. A Cursor
 * install with the payload in three of five processes would route some traffic
 * and not the rest, which is harder to diagnose than no install at all.
 */
export function applyPlan(plan: PatchPlan, options: PatchOptions): ApplyResult {
  const log = options.log ?? (() => {});
  const patched: PlanEntry[] = [];
  const manifestEntries: ManifestEntry[] = [];
  const touched: string[] = [];

  const skipped = plan.entries.filter((entry) => entry.action === 'current');
  const pending = plan.entries.filter((entry) => entry.action !== 'current');

  for (const entry of pending) {
    const { target } = entry;
    try {
      const current = readFileSync(target.file, 'utf-8');
      // A refresh removes the old payload first, so payloads never stack.
      const { source: pristine, removed } = stripPayload(current);
      if (removed > 0) log(`  ${target.id}: removed ${removed} stale payload block(s)`);

      const backup = createBackup(target.file);
      if (backup.created) log(`  ${target.id}: backed up to ${backup.backup}`);

      const payload = renderPayload(target, options);
      const next = payload + pristine;
      writeFileAtomic(target.file, next);
      touched.push(target.file);

      verifyPatched(target.file, payload, pristine);

      patched.push(entry);
      manifestEntries.push({
        targetId: target.id,
        file: target.file,
        backup: backupPathFor(target.file),
        runtime: target.runtime,
        originalSize: Buffer.byteLength(pristine, 'utf-8'),
        patchedAt: new Date().toISOString(),
      });
      log(`  ${target.id}: patched (${target.runtime}, ${formatSize(target.sizeBytes)})`);
    } catch (error) {
      for (const file of touched) restoreBackup(file);
      return {
        layout: plan.layout,
        patched: [],
        skipped,
        checksums: { updated: [], untracked: [], changed: false, backup: null },
        manifestEntries: [],
        rolledBack: { failedTarget: target.id, error: (error as Error).message },
      };
    }
  }

  // Integrity metadata is updated last: it has to describe the files as they
  // now are on disk.
  const checksumEntries = patched
    .filter((entry) => entry.target.checksumKey)
    .map((entry) => ({ key: entry.target.checksumKey as string, file: entry.target.file }));
  const checksums = updateChecksums(plan.layout.productJson, checksumEntries);
  for (const update of checksums.updated) log(`  product.json: refreshed checksum for ${update.key}`);

  return { layout: plan.layout, patched, skipped, checksums, manifestEntries, rolledBack: null };
}

function renderPayload(target: DiscoveredTarget, options: PatchOptions): string {
  const guardMarker = guardMarkerFor(target);
  if (target.runtime === 'node') {
    return buildPayload({
      processLabel: target.processLabel,
      guardMarker,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
  }
  return buildRendererPayload({
    processLabel: target.processLabel,
    guardMarker,
    server: { host: options.config.server.host, port: options.config.server.port },
    byokMode: options.config.byokMode,
    hostPatterns: [...options.config.interception.hostPatterns],
    redirect: [...options.config.redirect],
  });
}

/**
 * Confirms the file on disk is exactly payload plus original.
 *
 * Reading it back also catches a truncated or partially flushed write, which a
 * comparison against the in-memory string would miss.
 */
function verifyPatched(file: string, payload: string, pristine: string): void {
  const written = readFileSync(file, 'utf-8');
  if (written.length !== payload.length + pristine.length) {
    throw new Error(
      `verification failed: expected ${payload.length + pristine.length} bytes, found ${written.length}`,
    );
  }
  if (!written.startsWith(payload)) throw new Error('verification failed: payload prefix mismatch');
  if (written.slice(payload.length) !== pristine) {
    throw new Error('verification failed: original content was altered');
  }
}

export interface TargetStatus {
  id: string;
  file: string;
  runtime: 'node' | 'renderer';
  present: boolean;
  patched: boolean;
  stale: boolean;
  backed_up: boolean;
}

export interface InstallStatus {
  layout: InstallLayout;
  targets: TargetStatus[];
  fullyPatched: boolean;
  partiallyPatched: boolean;
}

export function inspectInstall(layout: InstallLayout): InstallStatus {
  const { targets } = discoverTargets(layout);
  const statuses: TargetStatus[] = targets.map((target) => {
    const guard = guardMarkerFor(target);
    const present = existsSync(target.file);
    const source = present ? readFileSync(target.file, 'utf-8') : '';
    const patched = present && hasPayload(source, guard);
    return {
      id: target.id,
      file: target.file,
      runtime: target.runtime,
      present,
      patched,
      stale: patched && hasStalePayload(source, guard),
      backed_up: present && hasBackup(target.file),
    };
  });

  const patchedCount = statuses.filter((status) => status.patched && !status.stale).length;
  return {
    layout,
    targets: statuses,
    fullyPatched: statuses.length > 0 && patchedCount === statuses.length,
    partiallyPatched: patchedCount > 0 && patchedCount < statuses.length,
  };
}

export interface UninstallResult {
  layout: InstallLayout;
  restored: string[];
  stripped: string[];
  failed: { file: string; error: string }[];
}

/**
 * Returns an installation to its unmodified state.
 *
 * A backup is preferred because it restores the file exactly. When one is
 * missing — deleted by hand, or lost to a Cursor upgrade — the payload block
 * is removed from the file instead, which reaches the same result as long as
 * the markers are intact.
 */
export function uninstallInstall(layout: InstallLayout, extraFiles: string[] = []): UninstallResult {
  const { targets } = discoverTargets(layout);
  const result: UninstallResult = { layout, restored: [], stripped: [], failed: [] };

  const files = new Set<string>([
    ...targets.map((target) => target.file),
    ...extraFiles,
    layout.productJson,
  ]);

  for (const file of files) {
    try {
      if (restoreBackup(file)) {
        result.restored.push(file);
        continue;
      }
      if (!existsSync(file)) continue;
      const source = readFileSync(file, 'utf-8');
      const { source: cleaned, removed } = stripPayload(source);
      if (removed > 0) {
        writeFileAtomic(file, cleaned);
        result.stripped.push(file);
      }
    } catch (error) {
      result.failed.push({ file, error: (error as Error).message });
    }
  }

  return result;
}

export function buildManifest(
  toolkitVersion: string,
  results: { result: ApplyResult; productBackup: string | null }[],
): InstallManifest {
  return {
    $schemaVersion: 1,
    toolkitVersion,
    installs: results.map(({ result, productBackup }) => ({
      root: result.layout.root,
      kind: result.layout.kind,
      cursorVersion: result.layout.version,
      productBackup,
      entries: result.manifestEntries,
    })),
  };
}

/** Resolves a `product.json` checksum key to its file. */
export function checksumFileResolver(layout: InstallLayout): (key: string) => string {
  return (key) => join(layout.outDir, ...key.split('/'));
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}
