/**
 * Bundle entry for the injected payload.
 *
 * The installer prepends the bundled form of this module to a Cursor file and
 * writes the options object immediately before it. Keeping the entry this thin
 * means the payload has exactly one job — call `install` and never throw —
 * while all the behaviour stays in ordinary, type-checked, testable modules.
 */

import { install, type InstallOptions } from './index.js';

const OPTIONS_KEY = '__mycursorPayloadOptions';

function readOptions(): InstallOptions {
  const raw = (globalThis as Record<string, unknown>)[OPTIONS_KEY];
  if (raw && typeof raw === 'object' && typeof (raw as InstallOptions).processLabel === 'string') {
    return raw as InstallOptions;
  }
  return { processLabel: 'unknown' };
}

const options = readOptions();

try {
  install(options);
} catch (error) {
  // The host process must survive a broken payload, so this is the last line
  // of defence: report and leave Node's primitives exactly as they were.
  console.warn(
    `[mycursor:${options.processLabel}] interception install failed: ${(error as Error).message}`,
  );
} finally {
  delete (globalThis as Record<string, unknown>)[OPTIONS_KEY];
}

export { OPTIONS_KEY };
