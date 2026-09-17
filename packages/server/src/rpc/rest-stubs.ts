/**
 * Account REST endpoints.
 *
 * These are plain JSON, not protobuf, which makes them the one part of
 * Cursor's control plane that can be answered exactly without its schemas. It
 * is worth answering them: a BYOK session has no upstream subscription, and
 * left to reach the official API they return 401s that the client retries
 * indefinitely and renders as an account error over the chat surface.
 *
 * The shapes below mirror the fields Cursor reads. Anything it does not read is
 * omitted rather than guessed.
 */

import type { Exchange } from '../listener/exchange.js';

const STRIPE_PROFILE = {
  membershipType: 'pro',
  paymentId: 'mycursor-local',
  subscriptionStatus: 'active',
  verifiedStudent: false,
  trialEligible: false,
  trialLengthDays: 0,
  isOnStudentPlan: false,
  isOnBillableAuto: false,
  customerBalance: null,
  trialWasCancelled: false,
  isTeamMember: false,
  teamMembershipType: null,
  individualMembershipType: 'pro',
  lastPaymentFailed: false,
  pendingCancellationDate: null,
  isYearlyPlan: false,
};

type RestHandler = (exchange: Exchange) => void;

const HANDLERS = new Map<string, RestHandler>([
  ['/auth/full_stripe_profile', (exchange) => exchange.sendJson(200, STRIPE_PROFILE)],
  [
    '/auth/stripe_profile',
    // Cursor reads this one as plain text, not JSON.
    (exchange) =>
      exchange.send({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: new TextEncoder().encode(JSON.stringify(STRIPE_PROFILE)),
      }),
  ],
  ['/auth/has_valid_payment_method', (exchange) => exchange.sendJson(200, { hasValidPaymentMethod: true })],
  [
    '/auth/poll',
    // Polling for a sign-in that will never complete; an empty accepted
    // response stops the loop without surfacing an error.
    (exchange) => exchange.sendJson(200, {}),
  ],
  ['/auth/logout', (exchange) => exchange.sendJson(200, {})],
]);

export function claimsRestPath(path: string): boolean {
  return HANDLERS.has(path);
}

export function handleRestStub(exchange: Exchange, path: string): void {
  const handler = HANDLERS.get(path);
  if (!handler) {
    exchange.sendJson(404, { error: `mycursor: no stub for ${path}` });
    return;
  }
  handler(exchange);
}

export function restStubPaths(): string[] {
  return [...HANDLERS.keys()];
}
