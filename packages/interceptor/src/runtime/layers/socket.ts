/**
 * Socket-level interception: the layer that makes coverage complete.
 *
 * The path-aware layers only see clients that go through `http.request`,
 * `http2.connect`, or the global `fetch`. A bundled `undici`, a vendored
 * WebSocket client, or any library holding its own reference to `tls.connect`
 * escapes all of them. Capturing at `net.connect` / `tls.connect` catches
 * everything, because every TCP client in Node ends up here.
 *
 * The cost of capturing this low is that no request path exists yet, so the
 * decision is host-only and the server has to route per request and forward
 * what no rule claims. In exchange, a new Cursor transport cannot silently
 * bypass the toolkit.
 *
 * The original hostname is preserved as the TLS `servername`, so SNI carries
 * the intended upstream to the local listener without an extra header.
 *
 * Patching the module functions is not sufficient on its own. Node's HTTP
 * agents capture `net.createConnection` and `tls.connect` when `http.js` and
 * `https.js` are first evaluated, which is always before an injected payload
 * runs, so the agents keep calling the originals. The agent prototypes are
 * therefore patched as well — without them `https.request` slips straight past
 * this layer.
 */

import type { Socket } from 'node:net';

import type { RuntimeContext } from '../context.js';
import type { UplinkTarget } from '../uplink.js';

type LookupCallback = (
  error: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

const LAYER = 'socket' as const;
const LOOPBACK = '127.0.0.1';

interface ConnectArgs {
  options: Record<string, unknown>;
  callback: ((...args: unknown[]) => void) | undefined;
  host: string;
}

/**
 * Normalises the argument lists of `net.connect`, `tls.connect`, and
 * `Agent.prototype.createConnection`, which all overload the same three
 * positions differently.
 *
 * Returns null for IPC connections and anything else without a TCP host, which
 * the layer must leave alone.
 */
function parseConnectArgs(args: unknown[]): ConnectArgs | null {
  const [first] = args;
  let options: Record<string, unknown>;
  let callback: ((...a: unknown[]) => void) | undefined;

  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const port = Number.parseInt(String(first), 10);
    let host = 'localhost';
    let extra: Record<string, unknown> = {};
    for (const arg of args.slice(1)) {
      if (typeof arg === 'string') host = arg;
      else if (typeof arg === 'function') callback = arg as (...a: unknown[]) => void;
      else if (arg && typeof arg === 'object') extra = { ...(arg as Record<string, unknown>) };
    }
    options = { ...extra, port, host };
  } else if (first && typeof first === 'object') {
    options = { ...(first as Record<string, unknown>) };
    for (const arg of args.slice(1)) {
      if (typeof arg === 'function') callback = arg as (...a: unknown[]) => void;
      else if (arg && typeof arg === 'object') options = { ...options, ...(arg as Record<string, unknown>) };
    }
  } else {
    // A pipe or socket path; not TCP, so not ours.
    return null;
  }

  // IPC connections carry a socket path and no port. Node's HTTP agents also
  // pass a `path` key through to `createConnection`, but they null it out and
  // always supply a port — so testing for a path alone misclassifies every
  // agent-issued connection as IPC and lets it through unintercepted.
  const socketPath = options['path'];
  const isIpc = typeof socketPath === 'string' && socketPath.length > 0 && options['port'] === undefined;
  if (isIpc) return null;

  const host = firstNonEmpty(options['host'], options['hostname'], options['servername']);
  if (!host) return null;
  return { options, callback, host };
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Host-level verdict shared by every entry point this layer patches.
 *
 * `undefined` means "leave it alone"; a target (or `undefined` inside the
 * returned object) means capture, with readiness resolved in `lookup`.
 */
function verdict(
  ctx: RuntimeContext,
  parsed: ConnectArgs | null,
): { capture: false } | { capture: true; cached: UplinkTarget | undefined } {
  if (!parsed || ctx.isBypassed(parsed.options) || !ctx.router().isCandidateHost(parsed.host)) {
    return { capture: false };
  }
  const cached = ctx.cachedUplink();
  if (cached === null) {
    // Probed and unhealthy: let the request reach the official API.
    ctx.record(LAYER, 'passthrough');
    return { capture: false };
  }
  ctx.record(LAYER, 'captured');
  return { capture: true, cached };
}

export function installSocketLayer(ctx: RuntimeContext): void {
  const { http, https, net, tls } = ctx.originals.modules;

  const interceptedTlsConnect = function (this: unknown, ...args: unknown[]): unknown {
    const parsed = parseConnectArgs(args);
    const decision = verdict(ctx, parsed);
    if (!decision.capture || !parsed) {
      return ctx.originals.outer.tlsConnect(...(args as Parameters<typeof tls.connect>));
    }
    const options = buildSecureOptions(ctx, parsed, decision.cached);
    return parsed.callback
      ? ctx.originals.direct.tlsConnect(options as never, parsed.callback as never)
      : ctx.originals.direct.tlsConnect(options as never);
  };

  const interceptedNetConnect = function (this: unknown, ...args: unknown[]): unknown {
    const parsed = parseConnectArgs(args);
    const decision = verdict(ctx, parsed);
    if (!decision.capture || !parsed) {
      return ctx.originals.outer.netConnect(...(args as Parameters<typeof net.connect>));
    }
    const options = buildPlainOptions(ctx, parsed, decision.cached);
    return parsed.callback
      ? (ctx.originals.direct.netConnect(options as never, parsed.callback as never) as Socket)
      : (ctx.originals.direct.netConnect(options as never) as Socket);
  };

  tls.connect = interceptedTlsConnect as typeof tls.connect;
  net.connect = interceptedNetConnect as typeof net.connect;
  net.createConnection = interceptedNetConnect as typeof net.createConnection;

  patchAgentPrototype(ctx, https.Agent as unknown as AgentConstructor, interceptedTlsConnect, 'https');
  patchAgentPrototype(ctx, http.Agent as unknown as AgentConstructor, interceptedNetConnect, 'http');
}

/**
 * Redirects an agent's connection factory for candidate hosts only.
 *
 * The original factory does more than open a socket — session resumption and
 * proxy handling live there too — so it stays in charge of every connection
 * this toolkit does not claim.
 */
interface AgentConstructor {
  prototype: Record<string, unknown>;
}

function patchAgentPrototype(
  ctx: RuntimeContext,
  AgentClass: AgentConstructor,
  replacement: (...args: unknown[]) => unknown,
  label: string,
): void {
  const prototype = AgentClass?.prototype;
  const original = prototype?.['createConnection'];
  if (typeof original !== 'function') {
    ctx.logger.debug('agent prototype has no createConnection to patch', { agent: label });
    return;
  }
  if (prototype['__mycursorAgentPatched']) return;

  prototype['createConnection'] = function patchedCreateConnection(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const parsed = parseConnectArgs(args);
    if (!parsed || ctx.isBypassed(parsed.options) || !ctx.router().isCandidateHost(parsed.host)) {
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    }
    return replacement.apply(this, [parsed.options, ...args.filter((arg) => typeof arg === 'function')]);
  };
  prototype['__mycursorAgentPatched'] = true;
}

/**
 * Builds TLS options that terminate on the local listener while still telling
 * it which upstream the client meant.
 *
 * Certificate verification is disabled for these connections only: the peer is
 * a loopback listener whose certificate is generated locally and which the
 * client could not otherwise validate. Passthrough connections keep Node's
 * default verification untouched.
 */
function buildSecureOptions(
  ctx: RuntimeContext,
  parsed: ConnectArgs,
  cached: UplinkTarget | undefined,
): Record<string, unknown> {
  return ctx.markBypassed({
    ...parsed.options,
    host: parsed.host,
    port: cached ? cached.tlsPort : ctx.config().server.tlsPort,
    servername: firstNonEmpty(parsed.options['servername'], parsed.host),
    lookup: buildLookup(ctx, cached),
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  });
}

function buildPlainOptions(
  ctx: RuntimeContext,
  parsed: ConnectArgs,
  cached: UplinkTarget | undefined,
): Record<string, unknown> {
  return ctx.markBypassed({
    ...parsed.options,
    host: parsed.host,
    port: cached ? cached.port : ctx.config().server.port,
    lookup: buildLookup(ctx, cached),
  });
}

/**
 * Resolves the captured hostname to loopback, waiting for the server when its
 * state is not yet known.
 *
 * `lookup` is the only asynchronous hook available on the socket path, so it
 * doubles as the readiness gate. A failed wait surfaces as a connection error;
 * the probe it triggered then marks the server unhealthy, so the client's own
 * retry takes the passthrough branch above and reaches the official API.
 */
function buildLookup(
  ctx: RuntimeContext,
  cached: UplinkTarget | undefined,
): (hostname: string, options: unknown, callback: LookupCallback) => void {
  return (_hostname, options, callback) => {
    // Node's `autoSelectFamily` path asks for every address at once, and then
    // rejects a bare string with "Invalid IP address". Honour whichever shape
    // the caller asked for.
    const wantsAll = Boolean(
      options && typeof options === 'object' && (options as { all?: boolean }).all,
    );
    const resolved = (): void => {
      if (wantsAll) callback(null, [{ address: LOOPBACK, family: 4 }]);
      else callback(null, LOOPBACK, 4);
    };

    if (cached) {
      resolved();
      return;
    }
    void ctx
      .awaitUplink(LAYER)
      .then((uplink) => {
        if (uplink) resolved();
        else
          callback(
            new Error('mycursor: BYOK server did not become ready; retry will use the official API'),
          );
      })
      .catch((error: Error) => callback(error));
  };
}
