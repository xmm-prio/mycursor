/**
 * Identifying which RPC protocol a request speaks.
 *
 * Cursor's clients do not all use the same one. The renderer uses the Connect
 * protocol over `fetch`; the Node transports use Connect streaming or gRPC
 * over HTTP/2; and the same method can arrive as protobuf or as JSON. The
 * content type carries all of it, so parsing it once here keeps every handler
 * free of transport concerns.
 */

export type RpcProtocol = 'connect-unary' | 'connect-stream' | 'grpc' | 'grpc-web';
export type RpcFormat = 'proto' | 'json';

export interface RpcContentType {
  protocol: RpcProtocol;
  format: RpcFormat;
  /** True when the body is a sequence of enveloped frames. */
  enveloped: boolean;
  /** Value to send back on the response. */
  responseContentType: string;
}

const KNOWN: { prefix: string; protocol: RpcProtocol; format: RpcFormat; enveloped: boolean }[] = [
  { prefix: 'application/connect+proto', protocol: 'connect-stream', format: 'proto', enveloped: true },
  { prefix: 'application/connect+json', protocol: 'connect-stream', format: 'json', enveloped: true },
  { prefix: 'application/grpc-web+proto', protocol: 'grpc-web', format: 'proto', enveloped: true },
  { prefix: 'application/grpc-web+json', protocol: 'grpc-web', format: 'json', enveloped: true },
  { prefix: 'application/grpc-web', protocol: 'grpc-web', format: 'proto', enveloped: true },
  { prefix: 'application/grpc+proto', protocol: 'grpc', format: 'proto', enveloped: true },
  { prefix: 'application/grpc+json', protocol: 'grpc', format: 'json', enveloped: true },
  { prefix: 'application/grpc', protocol: 'grpc', format: 'proto', enveloped: true },
  { prefix: 'application/proto', protocol: 'connect-unary', format: 'proto', enveloped: false },
  { prefix: 'application/protobuf', protocol: 'connect-unary', format: 'proto', enveloped: false },
  { prefix: 'application/json', protocol: 'connect-unary', format: 'json', enveloped: false },
];

/**
 * Parses a content type, defaulting to Connect unary protobuf.
 *
 * The default matters: a request with a missing or unrecognised content type is
 * still more likely to be unary protobuf than anything else, and answering it
 * that way beats refusing it.
 */
export function parseContentType(raw: string | undefined | null): RpcContentType {
  const value = String(raw ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();

  const match = KNOWN.find((entry) => value === entry.prefix) ??
    KNOWN.find((entry) => value.startsWith(entry.prefix));

  if (!match) {
    return {
      protocol: 'connect-unary',
      format: 'proto',
      enveloped: false,
      responseContentType: 'application/proto',
    };
  }

  return {
    protocol: match.protocol,
    format: match.format,
    enveloped: match.enveloped,
    responseContentType: value || match.prefix,
  };
}

/** True when the protocol expects gRPC-style trailers rather than a status code. */
export function usesTrailers(protocol: RpcProtocol): boolean {
  return protocol === 'grpc' || protocol === 'grpc-web';
}
