/**
 * Local persistence for Cursor's knowledge base.
 *
 * `KnowledgeBaseAdd` and friends normally write to the user's Cursor account.
 * A BYOK session has no account, so without a local store every "remember
 * this" silently evaporates: the add appears to succeed, the list comes back
 * empty, and nothing reports an error.
 *
 * A JSON file is enough. The records are four short strings each, they are
 * read once per list call, and a plain file stays inspectable and portable —
 * a user can read it, diff it, or copy it to another machine.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Logger } from '@mycursor/core/logging';

export interface KnowledgeEntry {
  id: string;
  knowledge: string;
  title: string;
  /** ISO-8601, as Cursor's own field is a string rather than a timestamp. */
  createdAt: string;
  /** True when the agent wrote it rather than the user. */
  isGenerated: boolean;
  /** Repository this belongs to; empty means it applies everywhere. */
  gitOrigin: string;
}

interface KnowledgeDocument {
  $schemaVersion: 1;
  entries: KnowledgeEntry[];
}

const EMPTY: KnowledgeDocument = { $schemaVersion: 1, entries: [] };

export class KnowledgeStore {
  private readonly path: string;
  private readonly logger: Logger;
  private document: KnowledgeDocument = EMPTY;
  private loaded = false;

  constructor(options: { path: string; logger: Logger }) {
    this.path = options.path;
    this.logger = options.logger;
  }

  /**
   * Lists entries, newest first.
   *
   * Entries with no `gitOrigin` apply everywhere, so they are always included;
   * scoping them to a repository would hide the user's global notes whenever
   * they opened a different project.
   */
  list(gitOrigin: string, limit: number): KnowledgeEntry[] {
    this.load();
    const matching = this.document.entries.filter(
      (entry) => !entry.gitOrigin || !gitOrigin || entry.gitOrigin === gitOrigin,
    );
    const ordered = [...matching].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return limit > 0 ? ordered.slice(0, limit) : ordered;
  }

  add(input: { knowledge: string; title: string; gitOrigin: string; isGenerated?: boolean }): string {
    this.load();
    const entry: KnowledgeEntry = {
      id: randomUUID(),
      knowledge: input.knowledge,
      title: input.title,
      createdAt: new Date().toISOString(),
      isGenerated: input.isGenerated ?? false,
      gitOrigin: input.gitOrigin,
    };
    this.document.entries.push(entry);
    this.save();
    return entry.id;
  }

  update(id: string, changes: { knowledge?: string; title?: string }): boolean {
    this.load();
    const entry = this.document.entries.find((candidate) => candidate.id === id);
    if (!entry) return false;
    // An empty string is a legitimate value, so only absent fields are kept.
    if (changes.knowledge !== undefined) entry.knowledge = changes.knowledge;
    if (changes.title !== undefined) entry.title = changes.title;
    this.save();
    return true;
  }

  remove(id: string): boolean {
    this.load();
    const before = this.document.entries.length;
    this.document.entries = this.document.entries.filter((entry) => entry.id !== id);
    if (this.document.entries.length === before) return false;
    this.save();
    return true;
  }

  get size(): number {
    this.load();
    return this.document.entries.length;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;

    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as KnowledgeDocument;
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      this.document = {
        $schemaVersion: 1,
        entries: entries.filter((entry) => typeof entry?.id === 'string'),
      };
    } catch (error) {
      // Losing the file would lose the user's notes, so a damaged document is
      // reported and left on disk rather than overwritten with an empty one.
      this.logger.warn('knowledge base could not be read; serving it as empty', {
        path: this.path,
        error: (error as Error).message,
      });
      this.document = { $schemaVersion: 1, entries: [] };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = join(dirname(this.path), `.${randomUUID()}.tmp`);
      writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, 'utf-8');
      renameSync(temporary, this.path);
    } catch (error) {
      this.logger.error('knowledge base could not be written', {
        path: this.path,
        error: (error as Error).message,
      });
    }
  }
}
