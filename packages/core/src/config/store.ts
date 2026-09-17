/**
 * Live configuration with last-known-good retention.
 *
 * Both the interceptor runtime and the local server read configuration through
 * this store, and both must survive an operator editing the file underneath
 * them. Two properties make that safe:
 *
 *  - a revision is published only after it has parsed and compiled, so readers
 *    never observe a half-applied document;
 *  - an unreadable or invalid file leaves the previous revision in place, so a
 *    transient write never silently turns interception off.
 */

import { watch, type FSWatcher } from 'node:fs';

import { loadConfigFrom } from './loader.js';
import { resolveConfigPaths } from './paths.js';
import { RequestRouter } from '../routing/router.js';
import type { ConfigLoadStatus, MyCursorConfig } from './types.js';

export interface ConfigRevision {
  /** Monotonic counter, starting at 1 for the first successful load. */
  revision: number;
  config: MyCursorConfig;
  /** Router compiled from this revision; share it, do not rebuild per request. */
  router: RequestRouter;
  status: ConfigLoadStatus;
  source: string | null;
  warnings: string[];
  loadedAt: number;
}

export type ConfigListener = (revision: ConfigRevision) => void;

export interface ConfigStoreOptions {
  /** Absolute path of the configuration document. */
  path?: string;
  /** Coalesce bursts of filesystem events into one reload. */
  debounceMs?: number;
  /** Called for every retained-on-error or warning event. */
  onDiagnostic?: (message: string) => void;
}

export class ConfigStore {
  private revisionCounter = 0;
  private active: ConfigRevision;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<ConfigListener>();

  private constructor(
    private readonly path: string,
    private readonly debounceMs: number,
    private readonly onDiagnostic: (message: string) => void,
  ) {
    this.active = this.build();
  }

  static open(options: ConfigStoreOptions = {}): ConfigStore {
    const path = options.path ?? resolveConfigPaths().config;
    return new ConfigStore(path, options.debounceMs ?? 150, options.onDiagnostic ?? (() => {}));
  }

  private build(): ConfigRevision {
    const result = loadConfigFrom(this.path);
    const { router, warnings } = RequestRouter.compile({
      byokMode: result.config.byokMode,
      hostPatterns: result.config.interception.hostPatterns,
      redirect: result.config.redirect,
    });
    this.revisionCounter += 1;
    return {
      revision: this.revisionCounter,
      config: result.config,
      router,
      status: result.status,
      source: result.source,
      warnings: [...result.warnings, ...warnings],
      loadedAt: Date.now(),
    };
  }

  current(): ConfigRevision {
    return this.active;
  }

  /**
   * Re-reads the document. An invalid file is reported and discarded, leaving
   * the previously published revision active.
   */
  reload(): { changed: boolean; revision: ConfigRevision } {
    const next = this.build();
    if (next.status === 'invalid' && this.active.status !== 'invalid') {
      this.revisionCounter -= 1;
      for (const warning of next.warnings) {
        this.onDiagnostic(`config retained last-known-good revision ${this.active.revision}: ${warning}`);
      }
      return { changed: false, revision: this.active };
    }
    this.active = next;
    for (const warning of next.warnings) this.onDiagnostic(`config warning: ${warning}`);
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (error) {
        this.onDiagnostic(`config listener failed: ${(error as Error).message}`);
      }
    }
    return { changed: true, revision: next };
  }

  /**
   * Starts watching the configuration document.
   *
   * The watcher is attached to the containing directory rather than the file
   * itself: an atomic save replaces the inode, which would detach a file watch
   * permanently.
   */
  startWatching(): void {
    if (this.watcher) return;
    const directory = this.path.slice(0, Math.max(this.path.lastIndexOf('/'), this.path.lastIndexOf('\\')));
    const fileName = this.path.slice(directory.length + 1);
    try {
      this.watcher = watch(directory, { persistent: false }, (_event, changed) => {
        if (changed && changed !== fileName) return;
        this.scheduleReload();
      });
      this.watcher.on('error', (error) => {
        this.onDiagnostic(`config watcher error: ${error.message}`);
      });
    } catch (error) {
      this.onDiagnostic(`config watcher unavailable: ${(error as Error).message}`);
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reload();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }
}
