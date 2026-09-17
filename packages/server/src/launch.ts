#!/usr/bin/env node
/**
 * Standalone entry point for the BYOK server.
 *
 * The server runs as its own process rather than inside a Cursor built-in
 * extension. That choice is what lets the installer leave Cursor's extension
 * signature verification alone: hosting the server among the built-ins would
 * require patching that check, which is a far more invasive change than
 * prepending a payload.
 *
 * Lifecycle is therefore somebody else's job, and there are three options:
 * run this in a terminal, let the optional `@mycursor/extension` start it when
 * a window opens, or register it with the operating system's service manager.
 */

import { MyCursorServer } from './server.js';

async function main(): Promise<void> {
  const server = new MyCursorServer({
    ...(process.env['MYCURSOR_LOG_LEVEL']
      ? { logLevel: process.env['MYCURSOR_LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error' }
      : {}),
  });

  const running = await server.listen();

  // Emitted on stdout so a supervising process can wait for readiness without
  // polling the health endpoint.
  process.stdout.write(
    `${JSON.stringify({ ready: true, plainPort: running.plainPort, tlsPort: running.tlsPort })}\n`,
  );

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[mycursor:server] received ${signal}, shutting down\n`);
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error: Error) => {
  process.stderr.write(`[mycursor:server] failed to start: ${error.message}\n`);
  process.exit(1);
});
