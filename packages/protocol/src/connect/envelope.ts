/**
 * Enveloped frames, shared by Connect streaming, gRPC and gRPC-Web.
 *
 * All three wrap each message in the same five-byte header — one flag byte
 * followed by a big-endian length — and differ only in what the flags mean.
 * Encoding and decoding therefore live here once, and the protocol-specific
 * flag values stay with the protocols.
 */

/** Connect streaming: the final frame carries the end-of-stream JSON payload. */
export const FLAG_END_STREAM = 0b0000_0010;

/** gRPC-Web: the final frame carries the trailers. */
export const FLAG_TRAILER = 0b1000_0000;

/** gRPC and Connect: the payload is compressed. */
export const FLAG_COMPRESSED = 0b0000_0001;

export const ENVELOPE_HEADER_BYTES = 5;

export interface Envelope {
  flags: number;
  payload: Uint8Array;
}

export function encodeEnvelope(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(ENVELOPE_HEADER_BYTES + payload.length);
  frame[0] = flags & 0xff;
  // Big-endian length, per the Connect and gRPC specifications.
  frame[1] = (payload.length >>> 24) & 0xff;
  frame[2] = (payload.length >>> 16) & 0xff;
  frame[3] = (payload.length >>> 8) & 0xff;
  frame[4] = payload.length & 0xff;
  frame.set(payload, ENVELOPE_HEADER_BYTES);
  return frame;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Incremental frame decoder.
 *
 * Streaming bodies arrive in arbitrary chunks that rarely align with frame
 * boundaries, so the decoder buffers whatever it cannot yet complete. The
 * caller feeds chunks and drains whole frames.
 */
export class EnvelopeDecoder {
  // Typed against `ArrayBufferLike` because the buffer is advanced with
  // `subarray`, which keeps a view on the original allocation rather than
  // copying the remainder after every frame.
  private buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();

  push(chunk: Uint8Array): Envelope[] {
    this.buffered = concat([this.buffered, chunk]);
    const frames: Envelope[] = [];

    for (;;) {
      if (this.buffered.length < ENVELOPE_HEADER_BYTES) break;
      const length =
        ((this.buffered[1]! << 24) |
          (this.buffered[2]! << 16) |
          (this.buffered[3]! << 8) |
          this.buffered[4]!) >>>
        0;
      const total = ENVELOPE_HEADER_BYTES + length;
      if (this.buffered.length < total) break;

      frames.push({
        flags: this.buffered[0]!,
        payload: this.buffered.slice(ENVELOPE_HEADER_BYTES, total),
      });
      this.buffered = this.buffered.subarray(total);
    }

    return frames;
  }

  /** Bytes held back because they do not yet form a whole frame. */
  get pendingBytes(): number {
    return this.buffered.length;
  }
}

/** Decodes a complete body in one pass. */
export function decodeEnvelopes(body: Uint8Array): Envelope[] {
  const decoder = new EnvelopeDecoder();
  const frames = decoder.push(body);
  if (decoder.pendingBytes > 0) {
    throw new Error(`enveloped body ends mid-frame with ${decoder.pendingBytes} byte(s) left over`);
  }
  return frames;
}
