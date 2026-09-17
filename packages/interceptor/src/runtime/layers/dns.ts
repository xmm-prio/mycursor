/**
 * DNS interception — the escape hatch, disabled by default.
 *
 * Resolving Cursor's API hosts to loopback catches clients that hold private
 * references to every other primitive. It is blunt: it applies to the whole
 * host rather than to individual rules, so a request the route table would have
 * passed through also lands on the local server and has to be forwarded from
 * there. Enable it only when a future Cursor build slips past the other layers.
 */

import type { RuntimeContext } from '../context.js';

const LAYER = 'dns' as const;
const LOOPBACK = '127.0.0.1';

type LookupCallback = (
  error: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

export function installDnsLayer(ctx: RuntimeContext): void {
  const { dns } = ctx.originals.modules;

  dns.lookup = function interceptedLookup(this: unknown, ...args: unknown[]): unknown {
    const hostname = typeof args[0] === 'string' ? args[0] : '';
    const callback = args.find((arg) => typeof arg === 'function') as LookupCallback | undefined;
    const options = args[1] && typeof args[1] === 'object' ? (args[1] as { all?: boolean }) : null;

    if (!callback || !ctx.router().isCandidateHost(hostname)) {
      ctx.record(LAYER, 'passthrough');
      return ctx.originals.outer.dnsLookup(...(args as Parameters<typeof dns.lookup>));
    }

    ctx.record(LAYER, 'captured');
    if (options?.all) {
      callback(null, [{ address: LOOPBACK, family: 4 }]);
    } else {
      callback(null, LOOPBACK, 4);
    }
    return undefined;
  } as typeof dns.lookup;
}
