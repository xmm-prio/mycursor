/**
 * Pairing `RunSSE` with `BidiAppend`.
 *
 * Cursor's agent protocol splits one turn across two calls: `RunSSE` opens the
 * response stream and then waits, while the run request itself arrives on a
 * separate `BidiAppend` call correlated by request id. Either can arrive
 * first, so the registry has to work as a rendezvous rather than a queue.
 *
 * Getting this wrong is the failure the reference implementation warns about in
 * its own error text — a `RunSSE` that waits for a message that was routed
 * elsewhere hangs until it times out, and the user sees a prompt that never
 * answers. Sessions are therefore keyed only by request id, never by
 * connection, so a client that opens the two calls over different transports
 * still rendezvous correctly.
 */

import type { Logger } from '@mycursor/core/logging';

export interface SessionMessage {
  /** Raw protobuf payload as it arrived. */
  payload: Uint8Array;
  receivedAt: number;
}

interface Waiter {
  resolve: (message: SessionMessage | null) => void;
  timer: NodeJS.Timeout;
}

export interface SessionRegistryOptions {
  /** How long `RunSSE` waits for its first message. */
  firstMessageTimeoutMs?: number;
  /** How long an unclaimed session is retained. */
  sessionTtlMs?: number;
  logger: Logger;
}

class Session {
  readonly queued: SessionMessage[] = [];
  readonly waiters: Waiter[] = [];
  createdAt = Date.now();
  closed = false;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly firstMessageTimeoutMs: number;
  private readonly sessionTtlMs: number;
  private readonly logger: Logger;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: SessionRegistryOptions) {
    this.firstMessageTimeoutMs = options.firstMessageTimeoutMs ?? 30_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 300_000;
    this.logger = options.logger;
  }

  private session(requestId: string): Session {
    let session = this.sessions.get(requestId);
    if (!session) {
      session = new Session();
      this.sessions.set(requestId, session);
      this.ensureSweeper();
    }
    return session;
  }

  /**
   * Records a message from `BidiAppend`.
   *
   * A message that arrives before `RunSSE` is queued rather than dropped,
   * which is the ordering the client actually produces much of the time.
   */
  append(requestId: string, payload: Uint8Array): void {
    const session = this.session(requestId);
    const message: SessionMessage = { payload, receivedAt: Date.now() };

    const waiter = session.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    session.queued.push(message);
  }

  /** Waits for the next message for `requestId`, or null on timeout. */
  next(requestId: string, timeoutMs = this.firstMessageTimeoutMs): Promise<SessionMessage | null> {
    const session = this.session(requestId);
    const queued = session.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (session.closed) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = session.waiters.findIndex((entry) => entry.timer === timer);
        if (index !== -1) session.waiters.splice(index, 1);
        this.logger.warn('agent session timed out waiting for a run request', {
          requestId,
          waitedMs: timeoutMs,
        });
        resolve(null);
      }, timeoutMs);
      session.waiters.push({ resolve, timer });
    });
  }

  /** Releases a session and wakes any waiter with null. */
  close(requestId: string): void {
    const session = this.sessions.get(requestId);
    if (!session) return;
    session.closed = true;
    for (const waiter of session.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.sessions.delete(requestId);
  }

  /**
   * Drops sessions nothing ever claimed.
   *
   * Without this, a client that opens `BidiAppend` and then disappears — a
   * closed window, a killed subagent — leaks its payload for the lifetime of
   * the process.
   */
  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - this.sessionTtlMs;
      for (const [requestId, session] of this.sessions) {
        if (session.createdAt > cutoff || session.waiters.length > 0) continue;
        this.logger.debug('dropped an unclaimed agent session', { requestId });
        this.sessions.delete(requestId);
      }
      if (this.sessions.size === 0 && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, 30_000);
    this.sweeper.unref?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  dispose(): void {
    for (const requestId of [...this.sessions.keys()]) this.close(requestId);
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
