/**
 * Renderer-side routing state.
 *
 * The renderer is a browser context: no `require`, no filesystem, so it cannot
 * read the configuration document the Node payload watches. Its configuration
 * is therefore baked in at patch time and refreshed at runtime over a
 * server-sent event stream.
 *
 * That gives the renderer the same hot-reload behaviour as the Node side —
 * toggling BYOK mode or editing the route table takes effect without
 * restarting Cursor — while keeping the injected code free of I/O primitives
 * it does not have.
 */

import { RequestRouter } from '@mycursor/core/routing';

export interface RendererServer {
  host: string;
  port: number;
}

export interface RendererOptions {
  processLabel: string;
  /**
   * Per-target key set on `globalThis`, matching the Node payload's contract.
   *
   * The installer detects an existing payload by this marker, so a renderer
   * bundle without one would be re-patched on every install.
   */
  guardMarker: string;
  server: RendererServer;
  byokMode: boolean;
  hostPatterns: string[];
  redirect: string[];
}

export interface RendererConfigUpdate {
  byokMode?: boolean;
  hostPatterns?: string[];
  redirect?: string[];
}

const EVENT_PATH = '/__mycursor/events';

export class RendererState {
  private router: RequestRouter;
  private byokMode: boolean;
  private hostPatterns: string[];
  private redirect: string[];
  private stream: EventSource | null = null;

  constructor(readonly options: RendererOptions) {
    this.byokMode = options.byokMode;
    this.hostPatterns = [...options.hostPatterns];
    this.redirect = [...options.redirect];
    this.router = this.compile();
  }

  private compile(): RequestRouter {
    const { router, warnings } = RequestRouter.compile({
      byokMode: this.byokMode,
      hostPatterns: this.hostPatterns,
      redirect: this.redirect,
    });
    for (const warning of warnings) {
      console.warn(`[mycursor:${this.options.processLabel}] ${warning}`);
    }
    return router;
  }

  currentRouter(): RequestRouter {
    return this.router;
  }

  /** Base URL of the local server, always plaintext loopback. */
  baseUrl(): string {
    const host = this.options.server.host.includes(':')
      ? `[${this.options.server.host}]`
      : this.options.server.host;
    return `http://${host}:${this.options.server.port}`;
  }

  /**
   * Applies a configuration update, recompiling only when something changed.
   *
   * Recompiling rebuilds the regular expressions and lookup sets, so skipping
   * no-op updates matters: the event stream re-sends the full document on every
   * reconnect.
   */
  apply(update: RendererConfigUpdate): boolean {
    let changed = false;
    if (typeof update.byokMode === 'boolean' && update.byokMode !== this.byokMode) {
      this.byokMode = update.byokMode;
      changed = true;
    }
    if (Array.isArray(update.hostPatterns) && !sameList(update.hostPatterns, this.hostPatterns)) {
      this.hostPatterns = [...update.hostPatterns];
      changed = true;
    }
    if (Array.isArray(update.redirect) && !sameList(update.redirect, this.redirect)) {
      this.redirect = [...update.redirect];
      changed = true;
    }
    if (changed) this.router = this.compile();
    return changed;
  }

  /**
   * Subscribes to configuration changes.
   *
   * The browser's own `EventSource` reconnects automatically, so a server
   * restart recovers without any retry logic here. A renderer without
   * `EventSource` keeps the baked-in configuration, which still works.
   */
  startWatching(): void {
    if (this.stream || typeof EventSource === 'undefined') return;
    try {
      this.stream = new EventSource(`${this.baseUrl()}${EVENT_PATH}`);
      this.stream.addEventListener('config', (event) => {
        try {
          const data = String((event as { data?: unknown }).data ?? '');
          const changed = this.apply(JSON.parse(data) as RendererConfigUpdate);
          if (changed) {
            console.log(
              `[mycursor:${this.options.processLabel}] configuration updated (${this.redirect.length} rules, byok=${this.byokMode})`,
            );
          }
        } catch (error) {
          console.warn(
            `[mycursor:${this.options.processLabel}] malformed config event: ${(error as Error).message}`,
          );
        }
      });
    } catch (error) {
      console.warn(
        `[mycursor:${this.options.processLabel}] config stream unavailable: ${(error as Error).message}`,
      );
    }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export { EVENT_PATH };
