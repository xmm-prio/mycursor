/**
 * Configuration model shared by every layer of the toolkit.
 *
 * The model is intentionally declarative: the interceptor runtime, the local
 * server and the installer all derive their behaviour from this single
 * document, so a behavioural change never needs a code change in more than one
 * layer.
 */

/** A host/port pair the toolkit can listen on or dial. */
export interface Endpoint {
  host: string;
  port: number;
}

/**
 * The BYOK server listens twice.
 *
 * `port` serves plaintext HTTP/1.1 and h2c and is the target for the
 * path-aware interception layers. `tlsPort` serves TLS with ALPN for `h2` and
 * `http/1.1`, and is the target for the socket-level layer, which captures a
 * connection before any path is known and therefore cannot downgrade it to
 * plaintext.
 */
export interface ServerEndpoint extends Endpoint {
  tlsPort: number;
}

/**
 * Where an intercepted request should ultimately be delivered.
 *
 * - `local`  the BYOK server runs in the same network namespace as the patched
 *            process, so `server` is dialled directly.
 * - `tunnel` the patched process runs on a different machine (SSH remote
 *            workspace) and reaches the BYOK server through a forwarded port.
 * - `auto`   probe `local` first, fall back to `tunnel`.
 */
export type UplinkMode = 'local' | 'tunnel' | 'auto';

export interface UplinkConfig {
  mode: UplinkMode;
  /** Endpoint reachable from inside a remote workspace (forwarded port). */
  tunnel: ServerEndpoint;
  /** Seconds a resolved uplink stays valid before it is probed again. */
  probeTtlSeconds: number;
  /** Milliseconds to wait for a single reachability probe. */
  probeTimeoutMs: number;
}

/**
 * Individual interception layers. Each layer is independently switchable so a
 * layer that misbehaves on a future Cursor build can be disabled from config
 * instead of requiring a re-patch.
 */
export interface InterceptionLayers {
  /** `http.request` / `https.request` / `http.get` / `https.get`. */
  http1: boolean;
  /** `http2.connect` — used by ConnectRPC transports. */
  http2: boolean;
  /** `globalThis.fetch` plus the undici global dispatcher. */
  fetch: boolean;
  /** `net.connect` / `tls.connect` socket-level backstop. */
  socket: boolean;
  /** WebSocket upgrades (`ws` package and `globalThis.WebSocket`). */
  websocket: boolean;
  /** `dns.lookup` / `dns.resolve` last-resort net. */
  dns: boolean;
}

/**
 * How the runtime behaves while the BYOK server is not yet listening.
 *
 * `hold` keeps the socket open and retries, which prevents the client from
 * seeing a hard failure during Cursor start-up. `passthrough` lets the request
 * reach the official API instead.
 */
export type ReadinessStrategy = 'hold' | 'passthrough';

export interface ReadinessConfig {
  strategy: ReadinessStrategy;
  /** Total time a single request may wait for the server to come up. */
  maxWaitMs: number;
  /** Delay between readiness retries. */
  retryDelayMs: number;
  /** Seconds a successful readiness result is cached for. */
  cacheTtlSeconds: number;
}

/** How WebSocket transports to the official API are handled. */
export type WebSocketPolicy =
  /** Route the upgrade to the BYOK server, which implements the WS endpoint. */
  | 'route'
  /** Refuse the upgrade so the client falls back to its SSE transport. */
  | 'downgrade'
  /** Leave WebSocket traffic alone. */
  | 'ignore';

export interface InterceptionConfig {
  layers: InterceptionLayers;
  readiness: ReadinessConfig;
  websocketPolicy: WebSocketPolicy;
  /** Host patterns whose traffic may be intercepted, as regex sources. */
  hostPatterns: string[];
  /** Emit a diagnostic line for every routing decision. */
  verbose: boolean;
}

/**
 * What the BYOK server does with a captured request that no route rule claims.
 *
 * The socket-level layer captures whole connections before a path is known, so
 * unclaimed paths must be forwarded upstream for Cursor's native features to
 * keep working. `reject` exists for debugging the route table.
 */
export type UpstreamPolicy = 'proxy' | 'reject';

export interface UpstreamConfig {
  policy: UpstreamPolicy;
  /**
   * Port to reach the official API on.
   *
   * Configurable rather than fixed at 443 so traffic can be pointed at an
   * enterprise mirror, and so the verification harness can stand a mock API up
   * on an unprivileged port.
   */
  port: number;
  /** Timeout for a single upstream forward, in milliseconds. */
  timeoutMs: number;
  /** Attempts for an idempotent upstream forward before giving up. */
  retries: number;
}

/**
 * Requirement: Cursor's own tool definitions must survive BYOK routing.
 *
 * `nativePrecedence` keeps client-declared tools authoritative; server-side
 * augmentation may only add names that do not already exist.
 */
export interface ToolPolicyConfig {
  /** Preserve every tool the Cursor client declares in its run request. */
  preserveNative: boolean;
  /** Allow the server to append its own tools (web search, fetch, ...). */
  allowAugmentation: boolean;
  /** Tool names the server must never append even when augmenting. */
  augmentationDenyList: string[];
  /** Native tool names that must be forwarded even if augmentation is off. */
  nativeAllowList: string[];
}

/**
 * Web search, which Cursor normally runs on its own backend.
 *
 * A BYOK session loses that, so the server offers a replacement tool and runs
 * it itself. Off by default: it sends the user's queries to a third party,
 * which should be a decision rather than a surprise.
 */
export interface WebSearchConfig {
  enabled: boolean;
  /** One of `@mycursor/server`'s built-in backends. */
  backend: string;
  /** Empty for backends that need no account, such as DuckDuckGo. */
  apiKey: string;
  maxResults: number;
  /** Offer `web_fetch` too, when the backend can read pages. */
  allowFetch: boolean;
  /** Routes search traffic through a proxy, as provider calls can be. */
  proxyUrl: string;
}

export interface MyCursorConfig {
  $schemaVersion: number;
  /** Master switch: when false every rule is bypassed and traffic is native. */
  byokMode: boolean;
  server: ServerEndpoint;
  collector: Endpoint;
  uplink: UplinkConfig;
  interception: InterceptionConfig;
  upstream: UpstreamConfig;
  tools: ToolPolicyConfig;
  webSearch: WebSearchConfig;
  /** Route rules, see `@mycursor/core/routing` for the grammar. */
  redirect: string[];
}

/**
 * Outcome of a load attempt.
 *
 * `invalid` is kept distinct from `absent` because they call for different
 * behaviour: an absent file legitimately means "use defaults", whereas an
 * invalid file means the operator is mid-edit and the last known-good document
 * should be retained.
 */
export type ConfigLoadStatus = 'loaded' | 'absent' | 'invalid';

/** Result of loading a configuration document from disk. */
export interface ConfigLoadResult {
  status: ConfigLoadStatus;
  config: MyCursorConfig;
  /** Absolute path the document was read from, or null when defaults were used. */
  source: string | null;
  /** Non-fatal problems found while normalising the document. */
  warnings: string[];
}
