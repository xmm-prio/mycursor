/**
 * Preload that makes the harness's test domain resolvable.
 *
 * Loaded with `node --require`, so it runs before the patched host module and
 * therefore before the interception payload. That ordering matters: the payload
 * captures the DNS primitive as it finds it, so this override becomes the
 * resolver used on the *passthrough* path — which is what lets the matrix
 * observe a request reaching the mock upstream instead of failing to resolve.
 *
 * `net.connect` reads `dns.lookup` off the module object at call time, so a
 * single assignment covers `https.request`, `http2.connect`, `tls.connect` and
 * `undici` alike.
 */

'use strict';

const dns = require('dns');

const SUFFIX = '.cursor.test';
const ADDRESS = '127.0.0.1';
const FAMILY = 4;

const originalLookup = dns.lookup;

dns.lookup = function patchedLookup(hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : options || {};
  const name = String(hostname || '').toLowerCase();

  if (typeof done === 'function' && (name.endsWith(SUFFIX) || name === SUFFIX.slice(1))) {
    if (opts.all) {
      process.nextTick(() => done(null, [{ address: ADDRESS, family: FAMILY }]));
    } else {
      process.nextTick(() => done(null, ADDRESS, FAMILY));
    }
    return undefined;
  }
  return originalLookup.apply(dns, arguments);
};

if (dns.promises && typeof dns.promises.lookup === 'function') {
  const originalPromise = dns.promises.lookup;
  dns.promises.lookup = function patchedPromiseLookup(hostname, options) {
    const name = String(hostname || '').toLowerCase();
    if (name.endsWith(SUFFIX)) {
      return Promise.resolve(
        options && options.all
          ? [{ address: ADDRESS, family: FAMILY }]
          : { address: ADDRESS, family: FAMILY },
      );
    }
    return originalPromise.apply(dns.promises, arguments);
  };
}
