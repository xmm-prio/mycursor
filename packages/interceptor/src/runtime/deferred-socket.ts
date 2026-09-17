/**
 * A Duplex that stands in for a socket whose destination is not known yet.
 *
 * `http2.connect` and several other Node APIs demand a stream synchronously,
 * which normally forces an interceptor to commit to a destination before it can
 * know whether the local server is up. This stream removes that constraint: it
 * is returned immediately, buffers whatever the client writes, and attaches to
 * a real socket once one has been chosen.
 *
 * It mimics the parts of `net.Socket` that HTTP clients actually touch —
 * `connecting`, the `connect` event, and the no-op tuning methods — so callers
 * cannot tell the difference until the decision has been made.
 */

import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';

export type SocketFactory = () => Promise<Socket>;

export class DeferredSocket extends Duplex {
  /** Mirrors `net.Socket.connecting`; HTTP clients branch on it. */
  connecting = true;

  private underlying: Socket | null = null;
  private readonly pending: { chunk: Buffer; encoding: BufferEncoding; callback: (error?: Error | null) => void }[] = [];
  private endRequested = false;
  private destroyed_ = false;
  private noDelay = false;
  private keepAlive: { enable: boolean; initialDelay: number } | null = null;

  constructor(factory: SocketFactory) {
    super({ allowHalfOpen: false });
    void this.attach(factory);
  }

  private async attach(factory: SocketFactory): Promise<void> {
    let socket: Socket;
    try {
      socket = await factory();
    } catch (error) {
      this.connecting = false;
      this.destroy(error as Error);
      return;
    }

    if (this.destroyed_) {
      socket.destroy();
      return;
    }

    this.underlying = socket;
    if (this.noDelay) socket.setNoDelay(true);
    if (this.keepAlive) socket.setKeepAlive(this.keepAlive.enable, this.keepAlive.initialDelay);

    socket.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) socket.pause();
    });
    socket.on('end', () => this.push(null));
    socket.on('error', (error: Error) => this.destroy(error));
    socket.on('close', () => {
      if (!this.destroyed_) this.push(null);
    });

    const ready = (): void => {
      this.connecting = false;
      for (const item of this.pending.splice(0)) {
        socket.write(item.chunk, item.encoding, item.callback);
      }
      if (this.endRequested) socket.end();
      this.emit('connect');
      this.emit('ready');
    };

    if (socket.connecting) socket.once('connect', ready);
    else ready();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.underlying && !this.connecting) {
      this.underlying.write(chunk, encoding, callback);
      return;
    }
    this.pending.push({ chunk, encoding, callback });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.endRequested = true;
    if (this.underlying && !this.connecting) this.underlying.end();
    callback();
  }

  override _read(): void {
    this.underlying?.resume();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.destroyed_ = true;
    this.connecting = false;
    for (const item of this.pending.splice(0)) {
      item.callback(error ?? new Error('mycursor: deferred socket destroyed'));
    }
    this.underlying?.destroy();
    callback(error);
  }

  // `net.Socket` surface HTTP clients call on a freshly created socket. These
  // are recorded and replayed so the real socket ends up configured the same
  // way it would have been without the indirection.

  setNoDelay(enable = true): this {
    this.noDelay = enable;
    this.underlying?.setNoDelay(enable);
    return this;
  }

  setKeepAlive(enable = false, initialDelay = 0): this {
    this.keepAlive = { enable, initialDelay };
    this.underlying?.setKeepAlive(enable, initialDelay);
    return this;
  }

  setTimeout(timeout: number, callback?: () => void): this {
    this.underlying?.setTimeout(timeout, callback);
    return this;
  }

  ref(): this {
    this.underlying?.ref();
    return this;
  }

  unref(): this {
    this.underlying?.unref();
    return this;
  }

  address(): Record<string, never> | ReturnType<Socket['address']> {
    return this.underlying?.address() ?? {};
  }

  get remoteAddress(): string | undefined {
    return this.underlying?.remoteAddress;
  }

  get remotePort(): number | undefined {
    return this.underlying?.remotePort;
  }
}
