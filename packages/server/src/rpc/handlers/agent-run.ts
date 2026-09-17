/**
 * `agent.v1.AgentService/RunSSE` and `aiserver.v1.BidiService/BidiAppend`.
 *
 * These two carry Cursor's native agent chat, and they are split across calls:
 * `RunSSE` opens the response stream with nothing but a request id, while the
 * run request itself arrives on a separate `BidiAppend`. Either can land
 * first, so the pair meets at a rendezvous keyed only by that id — never by
 * connection, because the two calls may take different transports.
 *
 * A turn that cannot be served is forwarded rather than failed. Answering
 * badly here is worse than not answering: the user is mid-conversation, and a
 * malformed frame looks like a broken IDE rather than a missing feature.
 */

import type { Logger } from '@mycursor/core/logging';
import { frameMessage, frameStreamEnd, parseContentType, RpcError } from '@mycursor/protocol/connect';
import type { DescriptorRegistry } from '@mycursor/protocol/schema';

import type { SessionRegistry } from '../../agent/session.js';
import {
  decodeRunRequest,
  encodeAppendResponse,
  encodeEvent,
  encodeTurnEnded,
  isAgentProtocolAvailable,
  readAppendRequestId,
  readRunRequestId,
} from '../../agent/protocol.js';
import type { TurnRunner } from '../../agent/turn.js';
import type { Exchange } from '../../listener/exchange.js';
import { unaryResponse } from '@mycursor/protocol/connect';
import type { ToolPolicyConfig } from '@mycursor/core/config';

export interface AgentHandlerDeps {
  registry: () => DescriptorRegistry;
  sessions: SessionRegistry;
  runner: TurnRunner;
  toolPolicy: () => ToolPolicyConfig;
  logger: Logger;
  /** True when a model is configured to serve the turn. */
  hasModels: () => boolean;
}

/**
 * Handles `BidiAppend`.
 *
 * The payload is only parked for the matching `RunSSE`; nothing is
 * interpreted here, because the same request id may carry several messages
 * and only the run request starts a turn.
 */
export async function handleBidiAppend(
  deps: AgentHandlerDeps,
  exchange: Exchange,
): Promise<boolean> {
  const registry = deps.registry();
  if (!isAgentProtocolAvailable(registry) || !deps.hasModels()) return false;

  const body = await exchange.body();
  const parsed = readAppendRequestId(registry, body);
  if (!parsed) {
    deps.logger.debug('BidiAppend carried no request id; forwarding');
    return false;
  }

  if (parsed.payload) {
    deps.sessions.append(parsed.requestId, parsed.payload);
    deps.logger.debug('parked an agent message', {
      requestId: parsed.requestId,
      bytes: parsed.payload.length,
    });
  }

  exchange.send(
    unaryResponse(parseContentType(exchange.headers['content-type']), encodeAppendResponse(registry)),
  );
  return true;
}

/**
 * Handles `RunSSE`.
 *
 * Returns false before writing anything when the turn cannot be served, which
 * lets the dispatcher forward the request instead.
 */
export async function handleRunSse(deps: AgentHandlerDeps, exchange: Exchange): Promise<boolean> {
  const registry = deps.registry();
  if (!isAgentProtocolAvailable(registry)) {
    deps.logger.debug('agent protocol unavailable; forwarding RunSSE');
    return false;
  }
  if (!deps.hasModels()) {
    deps.logger.debug('no model configured; forwarding RunSSE');
    return false;
  }

  const requestId = readRunRequestId(registry, await exchange.body());
  if (!requestId) {
    deps.logger.debug('RunSSE carried no request id; forwarding');
    return false;
  }

  // The run request may already be parked, or may be moments away.
  const message = await deps.sessions.next(requestId);
  if (!message) {
    deps.logger.warn('no run request arrived for this stream; forwarding', { requestId });
    deps.sessions.close(requestId);
    return false;
  }

  const decoded = decodeRunRequest(
    { registry, policy: deps.toolPolicy(), logger: deps.logger },
    message.payload,
  );
  if (!decoded) {
    deps.logger.debug('parked message was not a run request; forwarding', { requestId });
    deps.sessions.close(requestId);
    return false;
  }

  deps.logger.info('serving an agent turn', {
    requestId,
    model: decoded.turn.model,
    messages: decoded.turn.messages.length,
    protocolTools: decoded.nativeTools.length,
    mcpTools: decoded.mcpTools.length,
  });

  const contentType = parseContentType(exchange.headers['content-type']);
  const writer = exchange.beginStream(200, {
    'content-type': contentType.responseContentType,
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });

  const abort = new AbortController();
  writer.onClose(() => abort.abort());

  const egress = {
    registry,
    nativeTools: decoded.nativeTools,
    mcpTools: decoded.mcpTools,
    logger: deps.logger,
  };
  let usage = { inputTokens: 0, outputTokens: 0 };

  try {
    for await (const event of deps.runner.run(decoded.turn, abort.signal)) {
      if (writer.closed) break;
      if (event.type === 'turn-start') continue;
      if (event.type === 'usage') {
        usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      }
      const frame = encodeEvent(egress, event);
      if (frame) writer.write(frameMessage(contentType, frame));
    }

    if (!writer.closed) {
      writer.write(frameMessage(contentType, encodeTurnEnded(registry, usage)));
      writer.write(frameStreamEnd(contentType));
    }
  } catch (error) {
    // The stream is already open, so the failure travels inside it. A
    // protocol error at this point would discard text the user can see.
    deps.logger.error('agent turn failed', { requestId, error: (error as Error).message });
    if (!writer.closed) {
      const notice = encodeEvent(egress, {
        type: 'error',
        message: (error as Error).message,
        retryable: true,
      });
      if (notice) writer.write(frameMessage(contentType, notice));
      writer.write(frameStreamEnd(contentType, RpcError.from(error)));
    }
  } finally {
    writer.end();
    deps.sessions.close(requestId);
  }

  return true;
}
