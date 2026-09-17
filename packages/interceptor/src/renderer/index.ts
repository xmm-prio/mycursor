/**
 * Renderer payload entry.
 *
 * Mirrors the Node runtime's contract: idempotent through a version marker on
 * `globalThis`, and incapable of taking the host down — a failure here would
 * show up as a blank Cursor window, so every step is guarded.
 */

import { installRendererFetchLayer, installRendererWebSocketLayer } from './layers.js';
import { RendererReadiness } from './readiness.js';
import { RendererState, type RendererOptions } from './state.js';

export const RENDERER_VERSION = 1;

const VERSION_KEY = '__mycursorRendererVersion';
const STATE_KEY = '__mycursorRenderer';

export interface RendererInstallResult {
  installed: boolean;
  version: number;
  reason?: string;
}

export function installRenderer(options: RendererOptions): RendererInstallResult {
  const scope = globalThis as Record<string, unknown>;
  if (options.guardMarker) scope[options.guardMarker] = true;

  const existing = scope[VERSION_KEY];
  if (typeof existing === 'number') {
    return { installed: false, version: existing, reason: 'already-installed' };
  }
  scope[VERSION_KEY] = RENDERER_VERSION;

  const nativeFetch =
    typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  if (!nativeFetch) {
    delete scope[VERSION_KEY];
    return { installed: false, version: RENDERER_VERSION, reason: 'no-fetch' };
  }

  const state = new RendererState(options);
  const readiness = new RendererReadiness(() => state.baseUrl(), nativeFetch);
  scope[STATE_KEY] = state;

  const deps = { state, readiness, nativeFetch };
  for (const [name, install] of [
    ['fetch', installRendererFetchLayer],
    ['websocket', installRendererWebSocketLayer],
  ] as const) {
    try {
      install(deps);
    } catch (error) {
      console.warn(
        `[mycursor:${options.processLabel}] renderer ${name} layer failed: ${(error as Error).message}`,
      );
    }
  }

  state.startWatching();
  // Warm the cache so the first prompt does not have to wait on a probe.
  void readiness.check();

  console.log(
    `[mycursor:${options.processLabel}] renderer interception installed (server ${state.baseUrl()}, ${
      options.redirect.length
    } rules, byok=${options.byokMode})`,
  );
  return { installed: true, version: RENDERER_VERSION };
}

export type { RendererOptions } from './state.js';
export { VERSION_KEY as RENDERER_VERSION_KEY };
