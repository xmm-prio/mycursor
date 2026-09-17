/**
 * Loading and watching the extracted Cursor schema.
 *
 * The document is produced by `mycursor schema` from the installed
 * application, so it can appear, change after a Cursor upgrade, or be absent
 * entirely. The server must behave sensibly in all three cases, because
 * whether the schema is loaded determines whether a method can be answered
 * locally or has to be forwarded.
 *
 * Absent is a normal state, not an error: without descriptors the server still
 * answers control endpoints, REST stubs, empty-message methods and the
 * OpenAI-compatible façade, and forwards everything that needs the schema.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

import type { Logger } from '@mycursor/core/logging';
import { DescriptorRegistry, type DescriptorDocument } from '@mycursor/protocol/schema';

export interface DescriptorStoreOptions {
  path: string;
  logger: Logger;
}

export class DescriptorStore {
  private registry = DescriptorRegistry.empty();
  private loadedMtimeMs = 0;
  private loaded = false;

  constructor(private readonly options: DescriptorStoreOptions) {
    this.reload();
  }

  /**
   * Re-reads the document when its modification time changed.
   *
   * Polling on demand rather than watching keeps this off the hot path: the
   * check runs when a request needs the schema, and the document only changes
   * when the operator runs `mycursor schema`.
   */
  refreshIfChanged(): void {
    if (!existsSync(this.options.path)) return;
    try {
      const mtimeMs = statSync(this.options.path).mtimeMs;
      if (mtimeMs === this.loadedMtimeMs) return;
    } catch {
      return;
    }
    this.reload();
  }

  private reload(): void {
    const { path, logger } = this.options;
    if (!existsSync(path)) {
      if (this.loaded) logger.warn('descriptor document disappeared; schema-backed methods will be forwarded');
      this.registry = DescriptorRegistry.empty();
      this.loaded = false;
      return;
    }

    try {
      const document = JSON.parse(readFileSync(path, 'utf-8')) as DescriptorDocument;
      this.registry = DescriptorRegistry.fromDocument(document);
      this.loadedMtimeMs = statSync(path).mtimeMs;
      this.loaded = true;
      const stats = this.registry.stats();
      logger.info('cursor schema loaded', {
        cursorVersion: document.cursorVersion,
        messages: stats.messages,
        services: stats.services,
        methods: stats.methods,
      });
    } catch (error) {
      // Keep whatever was loaded before: a truncated write during
      // `mycursor schema` must not take schema-backed handling offline.
      logger.warn('descriptor document could not be read; keeping the previous schema', {
        error: (error as Error).message,
      });
    }
  }

  current(): DescriptorRegistry {
    return this.registry;
  }

  get available(): boolean {
    return this.loaded;
  }

  get cursorVersion(): string | null {
    return this.loaded ? this.registry.document.cursorVersion : null;
  }
}
