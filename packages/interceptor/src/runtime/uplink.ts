/**
 * Finding a healthy BYOK server to hand intercepted traffic to.
 *
 * Two questions collapse into one here: *which* endpoint to use (loopback in a
 * local window, a forwarded port inside an SSH remote workspace) and *whether*
 * a server is actually listening there. Answering them together means a layer
 * asks once and gets an endpoint it can use immediately, or nothing.
 *
 * The resolver is deliberately split into a synchronous cached read and an
 * asynchronous wait. Node's `http.request`, `http2.connect` and `tls.connect`
 * all return synchronously, so the fast path has to be cache-only; the wait is
 * driven from the asynchronous `createConnection` and `lookup` hooks, which is
 * what lets a request pause for a starting server instead of failing.
 */

import type { MyCursorConfig, ServerEndpoint } from '@mycursor/core/config';

import type { Originals } from './originals.js';

export type UplinkMode = 'local' | 'tunnel';

export interface UplinkTarget {
  mode: UplinkMode;
  host: string;
  /** Plaintext HTTP/1.1 and h2c port. */
  port: number;
  /** TLS port with ALPN, used by the socket layer. */
  tlsPort: number;
}

const HEALTH_PATH = '/__mycursor/health';

interface CacheEntry {
  target: UplinkTarget | null;
  checkedAt: number;
}

export interface UplinkResolverDeps {
  originals: Originals;
  readConfig: () => MyCursorConfig;
  onDiagnostic: (message: string, fields?: Record<string, unknown>) => void;
}

export class UplinkResolver {
  private cache: CacheEntry = { target: null, checkedAt: 0 };
  private inFlight: Promise<UplinkTarget | null> | null = null;
  /** When a wait last ran its full budget without finding a server. */
  private exhaustedAt = 0;

  constructor(private readonly deps: UplinkResolverDeps) {}

  /**
   * Cached answer for the synchronous fast path.
   *
   * Returns `undefined` when nothing has been probed yet, which a caller must
   * distinguish from `null` ("probed, nothing healthy"): the former warrants
   * waiting, the latter warrants passthrough.
   */
  cached(): UplinkTarget | null | undefined {
    const { probeTtlSeconds } = this.deps.readConfig().uplink;
    if (this.cache.checkedAt === 0) return undefined;
    if (Date.now() - this.cache.checkedAt > probeTtlSeconds * 1_000) return undefined;
    return this.cache.target;
  }

  /** Invalidates the cache, e.g. after a configuration change. */
  invalidate(): void {
    this.cache = { target: null, checkedAt: 0 };
    this.exhaustedAt = 0;
  }

  /**
   * Probes the configured candidates and caches the winner.
   *
   * Concurrent callers share one probe so a burst of requests during start-up
   * does not turn into a burst of health checks.
   */
  refresh(): Promise<UplinkTarget | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probeCandidates()
      .then((target) => {
        this.cache = { target, checkedAt: Date.now() };
        return target;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Waits up to `budgetMs` for a healthy server, retrying at the configured
   * interval. Resolves to `null` when the budget runs out.
   *
   * The wait exists for one situation: a server that is starting. It must not
   * be paid by every request when there is no server at all — that turns a
   * server which failed to start into an IDE where each call stalls for the
   * full budget before falling back, which is indistinguishable from a hang.
   * So once a wait has run its course, later requests pass straight through
   * until the probe TTL lapses and it is worth looking again.
   */
  async waitForTarget(budgetMs: number): Promise<UplinkTarget | null> {
    const cached = this.cached();
    if (cached) return cached;

    const config = this.deps.readConfig();
    const ttlMs = config.uplink.probeTtlSeconds * 1_000;
    if (this.exhaustedAt !== 0 && Date.now() - this.exhaustedAt < ttlMs) return null;

    const deadline = Date.now() + Math.max(0, budgetMs);
    const delay = config.interception.readiness.retryDelayMs;

    for (;;) {
      const target = await this.refresh();
      if (target) {
        this.exhaustedAt = 0;
        return target;
      }
      if (Date.now() + delay > deadline) {
        this.exhaustedAt = Date.now();
        this.deps.onDiagnostic('no BYOK server appeared; passing through until the probe TTL lapses', {
          waitedMs: budgetMs,
          ttlSeconds: config.uplink.probeTtlSeconds,
        });
        return null;
      }
      await sleep(delay);
    }
  }

  private candidates(): UplinkTarget[] {
    const config = this.deps.readConfig();
    const local = toTarget('local', config.server);
    const tunnel = toTarget('tunnel', config.uplink.tunnel);
    switch (config.uplink.mode) {
      case 'local':
        return [local];
      case 'tunnel':
        return [tunnel];
      case 'auto':
      default:
        return sameEndpoint(local, tunnel) ? [local] : [local, tunnel];
    }
  }

  private async probeCandidates(): Promise<UplinkTarget | null> {
    const config = this.deps.readConfig();
    for (const candidate of this.candidates()) {
      const healthy = await this.probe(candidate, config.uplink.probeTimeoutMs);
      if (healthy) return candidate;
    }
    return null;
  }

  /**
   * Confirms the endpoint is our server rather than an unrelated listener that
   * happens to hold the port, which would otherwise swallow model traffic.
   */
  private probe(target: UplinkTarget, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let request: import('node:http').ClientRequest;
      try {
        request = this.deps.originals.direct.httpRequest({
          host: target.host,
          port: target.port,
          path: HEALTH_PATH,
          method: 'GET',
          agent: false,
          headers: { 'x-mycursor-probe': '1' },
        });
      } catch (error) {
        this.deps.onDiagnostic('uplink probe could not start', {
          target: `${target.host}:${target.port}`,
          error: (error as Error).message,
        });
        finish(false);
        return;
      }

      request.setTimeout(timeoutMs, () => {
        request.destroy();
        finish(false);
      });
      request.on('error', () => finish(false));
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          if (chunks.length < 8) chunks.push(chunk);
        });
        response.on('end', () => {
          if (response.statusCode !== 200) return finish(false);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              ok?: boolean;
              service?: string;
            };
            finish(body.ok === true && body.service === 'mycursor');
          } catch {
            finish(false);
          }
        });
        response.on('error', () => finish(false));
      });
      request.end();
    });
  }
}

function toTarget(mode: UplinkMode, endpoint: ServerEndpoint): UplinkTarget {
  return { mode, host: endpoint.host, port: endpoint.port, tlsPort: endpoint.tlsPort };
}

function sameEndpoint(a: UplinkTarget, b: UplinkTarget): boolean {
  return a.host === b.host && a.port === b.port && a.tlsPort === b.tlsPort;
}

/**
 * Deliberately keeps a reference on the event loop.
 *
 * A held request has no socket yet, so this timer is the only thing standing
 * between the pending request and the process deciding it has nothing left to
 * do. The wait is bounded by `readiness.maxWaitMs`, so holding the loop open
 * cannot outlive the request it serves.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { HEALTH_PATH };
