/**
 * The toolkit's own HTTP surface, under `/__mycursor/`.
 *
 * The prefix is namespaced so it can never collide with a Cursor RPC path, and
 * every endpoint here is part of a contract something else depends on:
 *
 *  - `health` is what the interceptor probes. Its identity marker is the reason
 *    an unrelated process holding the port cannot be mistaken for this server
 *    and quietly swallow model traffic.
 *  - `events` is how the renderer payload — which has no filesystem — learns
 *    that the route table or BYOK mode changed.
 *  - `status` and `config` back the CLI and the control panel, so neither needs
 *    its own view of server state.
 */

import type { MyCursorConfig } from '@mycursor/core/config';

import type { Exchange, StreamWriter } from '../listener/exchange.js';

export const CONTROL_PREFIX = '/__mycursor/';
export const HEALTH_PATH = '/__mycursor/health';
export const EVENTS_PATH = '/__mycursor/events';
export const STATUS_PATH = '/__mycursor/status';
export const CONFIG_PATH = '/__mycursor/config';
export const TOGGLE_PATH = '/__mycursor/toggle';

/** Identity marker the interceptor's probe requires. */
export const SERVICE_MARKER = 'mycursor';

export interface ControlDeps {
  config: () => MyCursorConfig;
  /** Flips BYOK mode and persists it; returns the new value. */
  toggleByok: () => boolean;
  status: () => ServerStatusReport;
  version: string;
}

export interface ServerStatusReport {
  version: string;
  uptimeSeconds: number;
  byokMode: boolean;
  listeners: { plain: number | null; tls: number | null };
  providers: { id: string; kind: string; models: number }[];
  models: number;
  routeRules: number;
  /** Extracted Cursor schema, which decides what can be answered locally. */
  schema: {
    available: boolean;
    cursorVersion: string | null;
    messages: number;
    methods: number;
  };
  counters: Record<string, number>;
  warnings: string[];
}

/**
 * Broadcasts configuration to renderer payloads.
 *
 * The full document is sent on connect and on every change, so a renderer that
 * reconnects after a server restart converges without any catch-up protocol.
 */
export class ConfigBroadcaster {
  private readonly subscribers = new Set<StreamWriter>();

  attach(writer: StreamWriter, config: MyCursorConfig): void {
    this.subscribers.add(writer);
    writer.onClose(() => this.subscribers.delete(writer));
    this.send(writer, config);
  }

  broadcast(config: MyCursorConfig): void {
    for (const writer of [...this.subscribers]) {
      if (writer.closed) {
        this.subscribers.delete(writer);
        continue;
      }
      this.send(writer, config);
    }
  }

  private send(writer: StreamWriter, config: MyCursorConfig): void {
    const payload = JSON.stringify({
      byokMode: config.byokMode,
      hostPatterns: config.interception.hostPatterns,
      redirect: config.redirect,
    });
    writer.write(new TextEncoder().encode(`event: config\ndata: ${payload}\n\n`));
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

export class ControlRoutes {
  constructor(
    private readonly deps: ControlDeps,
    readonly broadcaster: ConfigBroadcaster,
  ) {}

  /** True when `path` belongs to the control surface. */
  claims(path: string): boolean {
    return path.startsWith(CONTROL_PREFIX);
  }

  handle(exchange: Exchange): void {
    const path = exchange.path.split('?')[0] ?? exchange.path;

    switch (path) {
      case HEALTH_PATH:
        // Deliberately minimal and unauthenticated: it is polled often, and a
        // probe must be able to tell "our server" from "some other listener"
        // without any prior state.
        exchange.sendJson(200, {
          ok: true,
          service: SERVICE_MARKER,
          version: this.deps.version,
          byokMode: this.deps.config().byokMode,
        });
        return;

      case STATUS_PATH:
        exchange.sendJson(200, this.deps.status());
        return;

      case CONFIG_PATH:
        exchange.sendJson(200, this.deps.config());
        return;

      case TOGGLE_PATH: {
        if (exchange.method !== 'POST') {
          exchange.sendJson(405, { error: 'toggle requires POST' });
          return;
        }
        const byokMode = this.deps.toggleByok();
        exchange.sendJson(200, { byokMode });
        return;
      }

      case EVENTS_PATH: {
        const writer = exchange.beginStream(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          // Streaming through a proxy that buffers would defeat the point.
          'x-accel-buffering': 'no',
        });
        this.broadcaster.attach(writer, this.deps.config());
        return;
      }

      default:
        exchange.sendJson(404, { error: `unknown control endpoint: ${path}` });
    }
  }
}
