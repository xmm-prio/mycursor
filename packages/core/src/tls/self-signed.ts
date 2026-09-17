/**
 * Self-signed certificate generation for the local TLS listener.
 *
 * The socket-level interception layer hands a TLS connection intended for
 * `api2.cursor.sh` to a loopback listener, so that listener needs a
 * certificate. Peer verification is disabled on exactly those connections —
 * the interceptor sets `rejectUnauthorized: false` for them and nothing else —
 * so the certificate's trust chain is irrelevant and only its structural
 * validity matters.
 *
 * Generating it at runtime, rather than shipping a key pair, means no private
 * key ever enters the repository and every installation gets its own.
 */

import {
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  bitString,
  boolean,
  contextConstructed,
  contextPrimitive,
  integer,
  nullValue,
  objectIdentifier,
  octetString,
  sequence,
  set,
  toPem,
  utcTime,
  utf8String,
} from './asn1.js';

const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const SAN_DNS = 2;
const SAN_IP = 7;

export interface CertificateMaterial {
  /** PEM-encoded private key. */
  key: string;
  /** PEM-encoded certificate. */
  cert: string;
  /** Expiry, so a cached certificate can be renewed before it lapses. */
  notAfter: Date;
}

export interface GenerateOptions {
  commonName?: string;
  /** DNS names the certificate covers. */
  dnsNames?: readonly string[];
  /** IPv4 addresses the certificate covers. */
  ipAddresses?: readonly string[];
  validDays?: number;
}

const DEFAULT_OPTIONS = {
  commonName: 'mycursor local listener',
  dnsNames: ['localhost', '*.cursor.sh', 'cursor.sh'] as readonly string[],
  ipAddresses: ['127.0.0.1'] as readonly string[],
  validDays: 825,
};

/** Builds an X.509 Name containing a single common name attribute. */
function name(commonName: string): Buffer {
  return sequence(set(sequence(objectIdentifier(OID_COMMON_NAME), utf8String(commonName))));
}

function subjectAltName(dnsNames: readonly string[], ipAddresses: readonly string[]): Buffer {
  const entries = [
    ...dnsNames.map((dns) => contextPrimitive(SAN_DNS, Buffer.from(dns, 'ascii'))),
    ...ipAddresses.map((ip) =>
      contextPrimitive(SAN_IP, Buffer.from(ip.split('.').map((part) => Number.parseInt(part, 10)))),
    ),
  ];
  return extension(OID_SUBJECT_ALT_NAME, false, sequence(...entries));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    objectIdentifier(oid),
    ...(critical ? [boolean(true)] : []),
    octetString(value),
  );
}

export function generateSelfSigned(options: GenerateOptions = {}): CertificateMaterial {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

  const notBefore = new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + config.validDays * 24 * 60 * 60 * 1000);
  const algorithm = sequence(objectIdentifier(OID_SHA256_RSA), nullValue());
  const subject = name(config.commonName);

  const tbs = sequence(
    contextConstructed(0, integer(2)), // v3
    integer(randomBytes(16)),
    algorithm,
    subject, // self-signed: issuer equals subject
    sequence(utcTime(notBefore), utcTime(notAfter)),
    subject,
    Buffer.from(spki),
    contextConstructed(
      3,
      sequence(
        subjectAltName(config.dnsNames, config.ipAddresses),
        // Digital signature + key encipherment, the usages a TLS server needs.
        extension(OID_KEY_USAGE, true, bitString(Buffer.from([0xa0]))),
        extension(OID_EXT_KEY_USAGE, false, sequence(objectIdentifier(OID_SERVER_AUTH))),
        extension(OID_BASIC_CONSTRAINTS, true, sequence()),
      ),
    ),
  );

  const signature = createSign('sha256').update(tbs).sign(privateKey);
  const certificate = sequence(tbs, algorithm, bitString(signature));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: toPem(certificate, 'CERTIFICATE'),
    notAfter,
  };
}

/**
 * Returns cached material from `directory`, generating it when absent or within
 * a week of expiry.
 *
 * Caching keeps the certificate stable across restarts, which matters because
 * TLS clients cache sessions keyed by certificate.
 */
export function loadOrCreateCertificate(
  directory: string,
  options: GenerateOptions = {},
): CertificateMaterial {
  const keyPath = join(directory, 'listener.key.pem');
  const certPath = join(directory, 'listener.cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      const key = readFileSync(keyPath, 'utf-8');
      const cert = readFileSync(certPath, 'utf-8');
      const notAfter = readCertificateExpiry(cert);
      if (notAfter && notAfter.getTime() - Date.now() > 7 * 24 * 60 * 60 * 1000) {
        return { key, cert, notAfter };
      }
    } catch {
      // Fall through and regenerate.
    }
  }

  const material = generateSelfSigned(options);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, material.key, { mode: 0o600 });
  writeFileSync(certPath, material.cert, { mode: 0o644 });
  return material;
}

/**
 * Reads the expiry from a PEM certificate using Node's own X.509 parser, which
 * also serves as a check that the generated DER is well formed.
 */
function readCertificateExpiry(pem: string): Date | null {
  try {
    return new Date(new X509Certificate(pem).validTo);
  } catch {
    return null;
  }
}
