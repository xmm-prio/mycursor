/**
 * Supervising the BYOK server process.
 *
 * The server deliberately lives outside Cursor, so something has to start and
 * stop it. Doing that here rather than hosting the server in-process keeps two
 * properties worth having: the extension can be uninstalled without taking the
 * server with it, and a server crash cannot take a Cursor window down.
 *
 * The supervisor is careful about one thing above all: it never starts a second
 * server. A duplicate would bind-fail at best and split model traffic across
 * two processes at worst, so an already-healthy server is adopted instead.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { MyCursorConfig } from '@mycursor/core/config';
import { HEALTH_PATH, SERVICE_MARKER } from '@mycursor/server';

export type ServerState = 'stopped' | 'starting' | 'running' | 'adopted' | 'failed';

export interface SupervisorDeps {
  config: () => MyCursorConfig;
  launcherPath: () => string;
  log: (message: string) => void;
}

export class ServerSupervisor {
  private child: ChildProcess | null = null;
  private state: ServerState = 'stopped';
  private startInFlight: Promise<ServerState> | null = null;

  constructor(private readonly deps: SupervisorDeps) {}

  currentState(): ServerState {
    return this.state;
  }

  /** Probes for a healthy server that identifies itself as ours. */
  async probe(): Promise<boolean> {
    const { host, port } = this.deps.config().server;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(`http://${host}:${port}${HEALTH_PATH}`, {
        signal: controller.signal,
      });
      const body = (await response.json()) as { ok?: boolean; service?: string };
      return body.ok === true && body.service === SERVICE_MARKER;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ensures a server is available.
   *
   * Concurrent callers share one attempt: several Cursor windows open at once
   * would otherwise race to spawn, and all but one would fail to bind.
   */
  ensureRunning(): Promise<ServerState> {
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.start().finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async start(): Promise<ServerState> {
    if (await this.probe()) {
      // Either a server started from a terminal, or one belonging to another
      // window. Adopting it is correct in both cases.
      this.state = this.child ? 'running' : 'adopted';
      this.deps.log(`adopted a healthy BYOK server on port ${this.deps.config().server.port}`);
      return this.state;
    }

    const launcher = this.deps.launcherPath();
    if (!existsSync(launcher)) {
      this.state = 'failed';
      this.deps.log(`server launcher not found at ${launcher}`);
      return this.state;
    }

    this.state = 'starting';
    this.deps.log(`starting BYOK server: ${process.execPath} ${launcher}`);

    // Detached and with stdio piped: the server outlives a window reload, and
    // its output still reaches the extension's channel while it does.
    const child = spawn(process.execPath, [launcher], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.deps.log(`[server] ${chunk.toString().trimEnd()}`));
    child.stderr?.on('data', (chunk: Buffer) => this.deps.log(`[server] ${chunk.toString().trimEnd()}`));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.state = 'stopped';
      this.deps.log(`BYOK server exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
    });
    child.on('error', (error) => {
      this.state = 'failed';
      this.deps.log(`BYOK server could not be started: ${error.message}`);
    });

    // Wait for readiness rather than assuming it, so the status bar and any
    // follow-up command reflect reality.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      // Read through the accessor: the child's `exit` and `error` handlers can
      // change the state while this loop is awaiting.
      const current = this.currentState();
      if (current === 'failed' || current === 'stopped') return current;
      if (await this.probe()) {
        this.state = 'running';
        this.deps.log('BYOK server is ready');
        return this.state;
      }
      await delay(250);
    }

    this.state = 'failed';
    this.deps.log('BYOK server did not become ready within 15s');
    return this.state;
  }

  /** Stops only a server this supervisor started. */
  stop(): void {
    if (!this.child) {
      this.deps.log('no server was started by this window; nothing to stop');
      return;
    }
    this.deps.log('stopping BYOK server');
    this.child.kill('SIGTERM');
    this.child = null;
    this.state = 'stopped';
  }

  async restart(): Promise<ServerState> {
    this.stop();
    await delay(300);
    return this.ensureRunning();
  }

  dispose(): void {
    this.stop();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
