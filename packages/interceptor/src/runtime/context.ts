/**
 * Shared state for the interception layers.
 *
 * Every layer needs the same four things: the current routing decision
 * function, a healthy uplink, a way to mark traffic the toolkit itself
 * originated, and somewhere to record what happened. Concentrating them here
 * keeps the layers small enough to reason about individually.
 */

import { ConfigStore, type MyCursorConfig } from '@mycursor/core/config';
import { Logger } from '@mycursor/core/logging';
import type { RequestRouter, RouteDecision } from '@mycursor/core/routing';

import { detectWindowId } from './headers.js';
import { captureOriginals, type Originals } from './originals.js';
import { UplinkResolver, type UplinkTarget } from './uplink.js';

/**
 * Marker placed on option objects the toolkit creates.
 *
 * Node passes `http`/`https` request options down to `tls.connect`, so a marker
 * set once at the top survives to the socket layer. That is what stops a
 * passthrough request from being re-captured lower in the stack and looping.
 */
export const BYPASS_KEY = '__mycursorBypass';

export interface LayerStats {
  intercepted: number;
  captured: number;
  passthrough: number;
  held: number;
  heldTimeouts: number;
  errors: number;
}

export type LayerName = 'http1' | 'http2' | 'fetch' | 'socket' | 'websocket' | 'dns';

export interface RuntimeStats {
  installedAt: number;
  layers: Record<LayerName, LayerStats>;
}

function emptyLayerStats(): LayerStats {
  return { intercepted: 0, captured: 0, passthrough: 0, held: 0, heldTimeouts: 0, errors: 0 };
}

export interface RuntimeContextOptions {
  /** Short label identifying the patched process in logs and headers. */
  processLabel: string;
  /** Overrides the configuration path; used by the verification harness. */
  configPath?: string;
}

export class RuntimeContext {
  readonly originals: Originals;
  readonly logger: Logger;
  readonly uplink: UplinkResolver;
  readonly stats: RuntimeStats;
  readonly windowId: string | null;

  private readonly store: ConfigStore;

  constructor(readonly options: RuntimeContextOptions) {
    this.originals = captureOriginals();
    this.logger = new Logger({ scope: options.processLabel });
    this.windowId = detectWindowId();
    this.store = ConfigStore.open({
      ...(options.configPath ? { path: options.configPath } : {}),
      onDiagnostic: (message) => this.logger.warn(message),
    });
    this.uplink = new UplinkResolver({
      originals: this.originals,
      readConfig: () => this.config(),
      onDiagnostic: (message, fields) => this.logger.debug(message, fields),
    });
    this.stats = {
      installedAt: Date.now(),
      layers: {
        http1: emptyLayerStats(),
        http2: emptyLayerStats(),
        fetch: emptyLayerStats(),
        socket: emptyLayerStats(),
        websocket: emptyLayerStats(),
        dns: emptyLayerStats(),
      },
    };

    // A configuration change can move the server, so the cached uplink has to
    // go with it; otherwise traffic keeps flowing to the old port.
    this.store.onChange((revision) => {
      this.uplink.invalidate();
      this.logger.info('configuration revision applied', {
        revision: revision.revision,
        byokMode: revision.config.byokMode,
        rules: revision.router.snapshot().rules,
      });
    });
    this.store.startWatching();
  }

  config(): MyCursorConfig {
    return this.store.current().config;
  }

  router(): RequestRouter {
    return this.store.current().router;
  }

  decide(query: { host?: string | null; path?: string | null }): RouteDecision {
    return this.router().resolve(query);
  }

  record(layer: LayerName, field: keyof LayerStats): void {
    this.stats.layers[layer][field] += 1;
  }

  /** True for option objects the toolkit created, which layers must not re-capture. */
  isBypassed(options: unknown): boolean {
    return Boolean(options && typeof options === 'object' && (options as Record<string, unknown>)[BYPASS_KEY]);
  }

  /** Stamps an option object as toolkit-originated. */
  markBypassed<T extends object>(options: T): T {
    (options as Record<string, unknown>)[BYPASS_KEY] = true;
    return options;
  }

  /**
   * Resolves an uplink for the synchronous decision path.
   *
   * `undefined` means "unknown, worth waiting for"; `null` means "probed and
   * unhealthy". A layer turns the first into a held connection and the second
   * into passthrough.
   */
  cachedUplink(): UplinkTarget | null | undefined {
    return this.uplink.cached();
  }

  /**
   * Waits for a healthy uplink within the configured readiness budget.
   *
   * Called from asynchronous connection hooks, which is what allows a request
   * issued while the server is still starting to pause rather than fail.
   */
  async awaitUplink(layer: LayerName): Promise<UplinkTarget | null> {
    const { readiness } = this.config().interception;
    if (readiness.strategy === 'passthrough') {
      return this.uplink.refresh();
    }
    this.record(layer, 'held');
    const target = await this.uplink.waitForTarget(readiness.maxWaitMs);
    if (!target) {
      this.record(layer, 'heldTimeouts');
      this.logger.warn('gave up waiting for the BYOK server, falling back to the official API', {
        layer,
        waitedMs: readiness.maxWaitMs,
      });
    }
    return target;
  }

  dispose(): void {
    this.store.close();
  }
}
