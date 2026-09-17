/**
 * The single place that decides what happens to an outbound request.
 *
 * Every interception layer and the server's own dispatcher ask the same
 * router, so a request is classified identically no matter which layer saw it
 * first. Layers differ only in how much they know: the socket layer supplies a
 * host, the others supply a host and a path.
 */

import { HostMatcher } from './host-matcher.js';
import { RouteTable } from './route-table.js';
import type { RouteRule } from './rules.js';

/** What the caller knows about the request. */
export interface RouteQuery {
  host?: string | null;
  /** Omitted by the socket layer, which has no path yet. */
  path?: string | null;
}

export type RouteAction =
  /** Deliver to the BYOK server, which owns the response. */
  | 'intercept'
  /**
   * Capture the connection but let the server decide per request. Only the
   * socket layer produces this, because it cannot see a path.
   */
  | 'capture'
  /** Leave the request alone. */
  | 'passthrough';

export interface RouteDecision {
  action: RouteAction;
  /** The rule that claimed the request, when one did. */
  rule: RouteRule | null;
  /** Short machine-readable explanation, used in logs and diagnostics. */
  reason: string;
}

const PASS = (reason: string): RouteDecision => ({ action: 'passthrough', rule: null, reason });

export interface RouterSnapshot {
  byokMode: boolean;
  hosts: number;
  rules: number;
}

export class RequestRouter {
  private constructor(
    private readonly hosts: HostMatcher,
    private readonly routes: RouteTable,
    private readonly byokMode: boolean,
  ) {}

  /**
   * Builds a router from raw configuration fragments. Warnings from host and
   * rule compilation are merged so a caller has one list to report.
   */
  static compile(input: {
    byokMode: boolean;
    hostPatterns: readonly string[];
    redirect: readonly string[];
  }): { router: RequestRouter; warnings: string[] } {
    const hosts = HostMatcher.compile(input.hostPatterns);
    const routes = RouteTable.compile(input.redirect);
    return {
      router: new RequestRouter(hosts.matcher, routes.table, input.byokMode),
      warnings: [...hosts.warnings, ...routes.warnings],
    };
  }

  /** A router that passes everything through, used before config is loaded. */
  static inert(): RequestRouter {
    return new RequestRouter(HostMatcher.empty(), RouteTable.empty(), false);
  }

  resolve(query: RouteQuery): RouteDecision {
    if (!this.byokMode) return PASS('byok-disabled');
    if (!this.hosts.matches(query.host)) return PASS('host-not-matched');

    if (query.path === undefined || query.path === null) {
      return { action: 'capture', rule: null, reason: 'host-matched-path-unknown' };
    }

    const rule = this.routes.match(query.path);
    if (!rule) return PASS('no-rule-for-path');
    return { action: 'intercept', rule, reason: `rule:${rule.kind}` };
  }

  /** True when the host alone makes the request a candidate for capture. */
  isCandidateHost(host: string | undefined | null): boolean {
    return this.byokMode && this.hosts.matches(host);
  }

  restPaths(): string[] {
    return this.routes.restPaths();
  }

  snapshot(): RouterSnapshot {
    return { byokMode: this.byokMode, hosts: this.hosts.size, rules: this.routes.size };
  }
}
