/**
 * The slice of ASN.1 DER needed to emit an X.509 certificate.
 *
 * Certificate generation is needed because the socket-level interception layer
 * terminates TLS locally, and there is no dependency-free way to obtain a
 * certificate otherwise: Node cannot generate one, and shipping a fixed
 * key pair in the repository would mean publishing a private key.
 *
 * Only the encoder is implemented — nothing here parses untrusted input.
 */

/** Wraps `contents` in a DER tag-length-value triple. */
export function der(tag: number, contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(contents.length), contents]);
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const sequence = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
export const set = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts));
export const utf8String = (value: string): Buffer => der(0x0c, Buffer.from(value, 'utf-8'));
export const printableString = (value: string): Buffer => der(0x13, Buffer.from(value, 'ascii'));
export const nullValue = (): Buffer => Buffer.from([0x05, 0x00]);
export const boolean = (value: boolean): Buffer => der(0x01, Buffer.from([value ? 0xff : 0x00]));

/** DER INTEGER, two's complement with the mandatory leading sign byte. */
export function integer(value: number | Buffer): Buffer {
  if (typeof value === 'number') {
    const bytes: number[] = [];
    let remaining = value;
    do {
      bytes.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    } while (remaining > 0);
    if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0x00);
    return der(0x02, Buffer.from(bytes));
  }
  const trimmed = value[0]! & 0x80 ? Buffer.concat([Buffer.from([0x00]), value]) : value;
  return der(0x02, trimmed);
}

/** DER BIT STRING with no unused trailing bits. */
export function bitString(contents: Buffer): Buffer {
  return der(0x03, Buffer.concat([Buffer.from([0x00]), contents]));
}

export const octetString = (contents: Buffer): Buffer => der(0x04, contents);

/** Encodes a dotted OID such as `1.2.840.113549.1.1.11`. */
export function objectIdentifier(dotted: string): Buffer {
  const parts = dotted.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`invalid object identifier: ${dotted}`);
  }
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunks: number[] = [];
    let remaining = part;
    do {
      chunks.unshift(remaining & 0x7f);
      remaining >>>= 7;
    } while (remaining > 0);
    for (let i = 0; i < chunks.length - 1; i += 1) chunks[i]! |= 0x80;
    bytes.push(...chunks);
  }
  return der(0x06, Buffer.from(bytes));
}

/** DER UTCTime, `YYMMDDHHMMSSZ`. */
export function utcTime(date: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return der(0x17, Buffer.from(text, 'ascii'));
}

/** Context-specific constructed tag, e.g. `[0] EXPLICIT`. */
export const contextConstructed = (index: number, contents: Buffer): Buffer =>
  der(0xa0 | index, contents);

/** Context-specific primitive tag, used for SubjectAltName entries. */
export const contextPrimitive = (index: number, contents: Buffer): Buffer =>
  der(0x80 | index, contents);

/** Wraps DER bytes in a PEM block. */
export function toPem(der_: Buffer, label: string): string {
  const body = der_.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body.endsWith('\n') ? body : `${body}\n`}-----END ${label}-----\n`;
}
