/**
 * Deciding what happens to each captured request.
 *
 * The interception layers capture by host; this is where a path finally gets a
 * verdict. The order is not arbitrary:
 *
 *  1. the toolkit's own control surface, which must never be confused with an
 *     RPC path;
 *  2. WebSocket upgrades, which are answered by policy rather than by a
 *     handler — refusing the upgrade is what makes Cursor fall back to its SSE
 *     transport, and it replaces the bundle surgery the reference
 *     implementation needs for the same effect;
 *  3. REST account endpoints;
 *  4. ConnectRPC methods, by strategy;
 *  5. everything else, forwarded upstream.
 *
 * Step 5 is the important one. Host-level capture means requests arrive here
 * that no rule claims, and forwarding them faithfully is what keeps Cursor's
 * native features — marketplace, feature gates, telemetry it needs — working
 * after installation.
 */

import type { MyCursorConfig } from '@mycursor/core/config';
import type { Logger } from '@mycursor/core/logging';
import { splitRpcPath, normalisePath } from '@mycursor/core/routing';
import { parseContentType, RpcError, errorResponse, unaryResponse } from '@mycursor/protocol/connect';
import { lookupMethod } from '@mycursor/protocol/schema';
import { EMPTY_MESSAGE } from '@mycursor/protocol/wire';

import type { ControlRoutes } from '../control/routes.js';
import type { Exchange } from '../listener/exchange.js';
import type { UpstreamProxy } from '../upstream/proxy.js';
import { handleRestStub, claimsRestPath } from './rest-stubs.js';

/** A handler for one fully-understood RPC method. */
export interface RpcHandler {
  (input: { exchange: Exchange; service: string; method: string }): Promise<boolean>;
}

export interface DispatcherDeps {
  config: () => MyCursorConfig;
  control: ControlRoutes;
  proxy: UpstreamProxy;
  logger: Logger;
  /** Handlers for methods this server answers itself, keyed `service/method`. */
  handlers: Map<string, RpcHandler>;
  /** Called for every decision, for the status counters. */
  record: (outcome: DispatchOutcome) => void;
  /** Serves an agent WebSocket upgrade; only used when policy is `route`. */
  serveWebSocket?: (exchange: Exchange) => void;
}

export type DispatchOutcome =
  | 'control'
  | 'websocket-refused'
  | 'websocket-served'
  | 'rest-stub'
  | 'rpc-local'
  | 'rpc-empty'
  | 'upstream';

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  async dispatch(exchange: Exchange): Promise<void> {
    const path = normalisePath(exchange.path);

    if (this.deps.control.claims(path)) {
      this.deps.record('control');
      this.deps.control.handle(exchange);
      return;
    }

    if (isUpgrade(exchange)) {
      this.handleUpgrade(exchange);
      return;
    }

    if (claimsRestPath(path)) {
      this.deps.record('rest-stub');
      handleRestStub(exchange, path);
      return;
    }

    const rpc = splitRpcPath(path);
    if (!rpc) {
      this.deps.record('upstream');
      await this.deps.proxy.forward(exchange);
      return;
    }

    await this.dispatchRpc(exchange, rpc.service, rpc.method);
  }

  private async dispatchRpc(exchange: Exchange, service: string, method: string): Promise<void> {
    const info = lookupMethod(service, method);
    const contentType = parseContentType(exchange.headers['content-type']);

    if (info.strategy === 'upstream') {
      this.deps.record('upstream');
      await this.deps.proxy.forward(exchange);
      return;
    }

    if (info.strategy === 'empty') {
      this.deps.record('rpc-empty');
      // Zero bytes is a valid encoding of any protobuf message, so this is a
      // well-formed reply that needs no knowledge of the response schema.
      exchange.send(unaryResponse(contentType, EMPTY_MESSAGE));
      return;
    }

    const handler = this.deps.handlers.get(`${service}/${method}`);
    if (!handler) {
      // Declared local but unimplemented: forwarding is strictly better than
      // answering wrongly, because the official API still knows how.
      this.deps.logger.debug('no local handler; forwarding upstream', { service, method });
      this.deps.record('upstream');
      await this.deps.proxy.forward(exchange);
      return;
    }

    try {
      const answered = await handler({ exchange, service, method });
      if (answered) {
        this.deps.record('rpc-local');
        return;
      }
      this.deps.record('upstream');
      await this.deps.proxy.forward(exchange);
    } catch (error) {
      const rpcError = RpcError.from(error);
      this.deps.logger.warn('rpc handler failed', {
        service,
        method,
        code: rpcError.code,
        error: rpcError.message,
      });
      exchange.send(errorResponse(contentType, rpcError));
    }
  }

  /**
   * Applies `interception.websocketPolicy`.
   *
   * `downgrade` answers 426, which every Cursor build treats as "this
   * transport is unavailable" and retries over SSE. Doing it here rather than
   * by editing Cursor's bundle means the choice is a configuration value and
   * survives every release.
   */
  private handleUpgrade(exchange: Exchange): void {
    const policy = this.deps.config().interception.websocketPolicy;

    if (policy === 'route' && this.deps.serveWebSocket) {
      this.deps.record('websocket-served');
      this.deps.serveWebSocket(exchange);
      return;
    }

    this.deps.record('websocket-refused');
    this.deps.logger.debug('refused a WebSocket upgrade so the client falls back to SSE', {
      path: exchange.path,
      policy,
    });
    exchange.send({
      status: 426,
      headers: { 'content-type': 'text/plain', connection: 'close' },
      body: new TextEncoder().encode('mycursor: WebSocket transport disabled; use SSE\n'),
    });
  }
}

function isUpgrade(exchange: Exchange): boolean {
  const upgrade = exchange.headers['upgrade'];
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}
