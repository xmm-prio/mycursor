/**
 * Renderer-side readiness gate.
 *
 * Interception in the renderer must never be the reason a request fails, so a
 * redirect only happens once the local server has identified itself. Until
 * then — and again once it stops answering — requests take their original
 * route to the official API.
 *
 * The identity check matters as much as the reachability check: an unrelated
 * process holding the port would otherwise swallow model traffic.
 */

const HEALTH_PATH = '/__mycursor/health';
const PROBE_TIMEOUT_MS = 800;

export class RendererReadiness {
  private healthy = false;
  private checkedAt = 0;
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly baseUrl: () => string,
    private readonly nativeFetch: typeof globalThis.fetch,
    private readonly ttlMs = 5_000,
  ) {}

  /** Cached verdict, or `undefined` when the cache has nothing fresh. */
  cached(): boolean | undefined {
    if (this.checkedAt === 0) return undefined;
    if (Date.now() - this.checkedAt > this.ttlMs) return undefined;
    return this.healthy;
  }

  /** Probes the server, coalescing concurrent callers onto one request. */
  check(): Promise<boolean> {
    const cached = this.cached();
    if (cached !== undefined) return Promise.resolve(cached);
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.probe()
      .then((healthy) => {
        this.healthy = healthy;
        this.checkedAt = Date.now();
        return healthy;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Forces the next `check` to probe again. */
  invalidate(): void {
    this.checkedAt = 0;
  }

  private async probe(): Promise<boolean> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null;
    try {
      // A unique query defeats any intermediate cache without relying on the
      // `cache` request option, which Node's fetch types do not expose.
      const url = `${this.baseUrl()}${HEALTH_PATH}?t=${Date.now()}`;
      const response = await this.nativeFetch(url, {
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { ok?: boolean; service?: string };
      return body.ok === true && body.service === 'mycursor';
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export { HEALTH_PATH };
