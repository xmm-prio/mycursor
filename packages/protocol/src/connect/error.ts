/**
 * Connect and gRPC error reporting.
 *
 * Getting the error shape right is not cosmetic. Cursor's clients branch on the
 * code: `unavailable` and `resource_exhausted` are retried, `unauthenticated`
 * triggers a sign-in prompt, `unimplemented` is surfaced as a hard failure.
 * A local server that reports the wrong code turns a recoverable hiccup into a
 * broken session, or worse, into a retry storm.
 */

export type ConnectCode =
  | 'canceled'
  | 'unknown'
  | 'invalid_argument'
  | 'deadline_exceeded'
  | 'not_found'
  | 'already_exists'
  | 'permission_denied'
  | 'resource_exhausted'
  | 'failed_precondition'
  | 'aborted'
  | 'out_of_range'
  | 'unimplemented'
  | 'internal'
  | 'unavailable'
  | 'data_loss'
  | 'unauthenticated';

/** Connect's code-to-HTTP-status mapping. */
const HTTP_STATUS: Record<ConnectCode, number> = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 412,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
};

/** gRPC numeric status codes, for the `grpc-status` trailer. */
const GRPC_STATUS: Record<ConnectCode, number> = {
  canceled: 1,
  unknown: 2,
  invalid_argument: 3,
  deadline_exceeded: 4,
  not_found: 5,
  already_exists: 6,
  permission_denied: 7,
  resource_exhausted: 8,
  failed_precondition: 9,
  aborted: 10,
  out_of_range: 11,
  unimplemented: 12,
  internal: 13,
  unavailable: 14,
  data_loss: 15,
  unauthenticated: 16,
};

export class RpcError extends Error {
  constructor(
    readonly code: ConnectCode,
    message: string,
    readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = 'RpcError';
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  get grpcStatus(): number {
    return GRPC_STATUS[this.code];
  }

  /** Connect's JSON error body. */
  toJson(): { code: ConnectCode; message: string; details?: unknown[] } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details.length > 0 ? { details: this.details } : {}),
    };
  }

  /**
   * Wraps an arbitrary throw.
   *
   * `unavailable` is the default rather than `internal` because an unexpected
   * failure in the local server is almost always transient — a provider
   * hiccup, a dropped socket — and `unavailable` is the code Cursor retries.
   */
  static from(error: unknown, fallback: ConnectCode = 'unavailable'): RpcError {
    if (error instanceof RpcError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new RpcError(fallback, message);
  }
}

export function grpcStatusFor(code: ConnectCode): number {
  return GRPC_STATUS[code];
}

/** Escapes a message for the `grpc-message` trailer, which is percent-encoded. */
export function encodeGrpcMessage(message: string): string {
  return encodeURIComponent(message);
}
