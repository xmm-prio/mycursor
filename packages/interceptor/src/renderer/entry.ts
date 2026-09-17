/**
 * Bundle entry for the renderer payload.
 *
 * The installer writes the options object immediately before this bundle, the
 * same way it does for the Node payload.
 */

import { installRenderer, type RendererOptions } from './index.js';

const OPTIONS_KEY = '__mycursorRendererOptions';

function readOptions(): RendererOptions | null {
  const raw = (globalThis as Record<string, unknown>)[OPTIONS_KEY];
  if (raw && typeof raw === 'object' && typeof (raw as RendererOptions).processLabel === 'string') {
    return raw as RendererOptions;
  }
  return null;
}

const options = readOptions();

try {
  if (options) installRenderer(options);
} catch (error) {
  console.warn(`[mycursor:renderer] interception install failed: ${(error as Error).message}`);
} finally {
  delete (globalThis as Record<string, unknown>)[OPTIONS_KEY];
}

export { OPTIONS_KEY };
