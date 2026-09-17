/**
 * Turning a handler result into wire bytes for whichever protocol asked.
 *
 * Handlers deal in messages; this module deals in framing, status codes and
 * trailers. Keeping the split sharp is what lets one set of handlers answer a
 * renderer using Connect over `fetch` and an agent process using gRPC over
 * HTTP/2 without either knowing about the other.
 */

import { concat, encodeEnvelope, FLAG_END_STREAM, FLAG_TRAILER } from './envelope.js';
import { encodeGrpcMessage, RpcError } from './error.js';
import type { RpcContentType } from './content-type.js';

const encoder = new TextEncoder();

export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Trailers for gRPC over HTTP/2, which sends them separately. */
  trailers?: Record<string, string>;
}

/** Serialises one message for a unary call. */
export function unaryResponse(contentType: RpcContentType, message: Uint8Array): WireResponse {
  if (contentType.enveloped) {
    // A unary method invoked over a streaming protocol still gets a frame, and
    // for Connect streaming an end-of-stream frame to close it.
    const frames: Uint8Array[] = [encodeEnvelope(message)];
    if (contentType.protocol === 'connect-stream') {
      frames.push(encodeEnvelope(encoder.encode('{}'), FLAG_END_STREAM));
    }
    if (contentType.protocol === 'grpc-web') {
      frames.push(encodeEnvelope(encoder.encode('grpc-status:0\r\n'), FLAG_TRAILER));
    }
    return {
      status: 200,
      headers: successHeaders(contentType),
      body: concat(frames),
      ...(contentType.protocol === 'grpc' ? { trailers: { 'grpc-status': '0' } } : {}),
    };
  }

  return { status: 200, headers: successHeaders(contentType), body: message };
}

/** Serialises a finished stream of messages. */
export function streamResponse(
  contentType: RpcContentType,
  messages: readonly Uint8Array[],
): WireResponse {
  const frames = messages.map((message) => encodeEnvelope(message));
  if (contentType.protocol === 'connect-stream') {
    frames.push(encodeEnvelope(encoder.encode('{}'), FLAG_END_STREAM));
  }
  if (contentType.protocol === 'grpc-web') {
    frames.push(encodeEnvelope(encoder.encode('grpc-status:0\r\n'), FLAG_TRAILER));
  }
  return {
    status: 200,
    headers: successHeaders(contentType),
    body: concat(frames),
    ...(contentType.protocol === 'grpc' ? { trailers: { 'grpc-status': '0' } } : {}),
  };
}

/**
 * Serialises an error.
 *
 * Streaming protocols have already sent a 200 by the time a handler fails, so
 * the error has to travel inside the body: an end-of-stream frame for Connect,
 * a trailer frame for gRPC-Web, trailers for gRPC. Only unary Connect can use
 * an HTTP status.
 */
export function errorResponse(contentType: RpcContentType, error: RpcError): WireResponse {
  if (contentType.protocol === 'connect-stream') {
    const payload = encoder.encode(JSON.stringify({ error: error.toJson() }));
    return {
      status: 200,
      headers: successHeaders(contentType),
      body: encodeEnvelope(payload, FLAG_END_STREAM),
    };
  }

  if (contentType.protocol === 'grpc-web') {
    const trailer = `grpc-status:${error.grpcStatus}\r\ngrpc-message:${encodeGrpcMessage(error.message)}\r\n`;
    return {
      status: 200,
      headers: successHeaders(contentType),
      body: encodeEnvelope(encoder.encode(trailer), FLAG_TRAILER),
    };
  }

  if (contentType.protocol === 'grpc') {
    return {
      status: 200,
      headers: successHeaders(contentType),
      body: new Uint8Array(),
      trailers: {
        'grpc-status': String(error.grpcStatus),
        'grpc-message': encodeGrpcMessage(error.message),
      },
    };
  }

  return {
    status: error.httpStatus,
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify(error.toJson())),
  };
}

function successHeaders(contentType: RpcContentType): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': contentType.responseContentType };
  if (contentType.protocol === 'grpc' || contentType.protocol === 'grpc-web') {
    headers['grpc-accept-encoding'] = 'identity';
  }
  return headers;
}

/** Frames a single message for incremental writing to an open stream. */
export function frameMessage(contentType: RpcContentType, message: Uint8Array): Uint8Array {
  return contentType.enveloped ? encodeEnvelope(message) : message;
}

/** The terminating frame for an incrementally written stream. */
export function frameStreamEnd(contentType: RpcContentType, error?: RpcError): Uint8Array {
  if (contentType.protocol === 'connect-stream') {
    const payload = error ? JSON.stringify({ error: error.toJson() }) : '{}';
    return encodeEnvelope(encoder.encode(payload), FLAG_END_STREAM);
  }
  if (contentType.protocol === 'grpc-web') {
    const trailer = error
      ? `grpc-status:${error.grpcStatus}\r\ngrpc-message:${encodeGrpcMessage(error.message)}\r\n`
      : 'grpc-status:0\r\n';
    return encodeEnvelope(encoder.encode(trailer), FLAG_TRAILER);
  }
  return new Uint8Array();
}
