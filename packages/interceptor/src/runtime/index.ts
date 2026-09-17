/**
 * Interception runtime entry point.
 *
 * This module is bundled into the payload that the installer prepends to
 * Cursor's own files, so it is the first code the patched process runs. Three
 * properties matter more than anything else here:
 *
 *  - **idempotence.** A process may load several patched bundles. A version
 *    marker on `globalThis` makes the second and later loads no-ops.
 *  - **containment.** A failure while installing must never take the host
 *    process down, so every step is individually guarded and a total failure
 *    leaves Node's primitives untouched.
 *  - **ordering.** Primitives are captured before any layer wraps them, and the
 *    first readiness probe is started immediately so the synchronous decision
 *    path has a warm cache by the time Cursor issues its first model request.
 */

import { RuntimeContext } from './context.js';
import { syncEsmExports } from './originals.js';
import { installDnsLayer } from './layers/dns.js';
import { installFetchLayer } from './layers/fetch.js';
import { installHttp1Layer } from './layers/http1.js';
import { installHttp2Layer } from './layers/http2.js';
import { installSocketLayer } from './layers/socket.js';
import { installWebSocketLayer } from './layers/websocket.js';
import type { LayerName } from './context.js';

/** Bumped whenever the payload's observable behaviour changes. */
export const RUNTIME_VERSION = 1;

const VERSION_KEY = '__mycursorInterceptorVersion';
const CONTEXT_KEY = '__mycursorInterceptor';

export interface InstallOptions {
  /** Short label identifying the patched process, e.g. `agent-host`. */
  processLabel: string;
  /** Overrides the configuration path; used by the verification harness. */
  configPath?: string;
  /** Guard key for the specific patch target, kept for installer diagnostics. */
  guardMarker?: string;
}

export interface InstallResult {
  installed: boolean;
  version: number;
  layers: LayerName[];
  reason?: string;
}

type LayerInstaller = (context: RuntimeContext) => void;

const LAYER_INSTALLERS: { name: LayerName; install: LayerInstaller }[] = [
  // Order matters: the path-aware layers must claim a request before the
  // socket backstop sees it, so that a rule-less path passes through natively
  // instead of taking a detour via the local server.
  { name: 'http1', install: installHttp1Layer },
  { name: 'http2', install: installHttp2Layer },
  { name: 'fetch', install: installFetchLayer },
  { name: 'websocket', install: installWebSocketLayer },
  { name: 'socket', install: installSocketLayer },
  { name: 'dns', install: installDnsLayer },
];

export function install(options: InstallOptions): InstallResult {
  const scope = globalThis as Record<string, unknown>;

  if (options.guardMarker) scope[options.guardMarker] = true;

  const existing = scope[VERSION_KEY];
  if (typeof existing === 'number') {
    return { installed: false, version: existing, layers: [], reason: 'already-installed' };
  }
  scope[VERSION_KEY] = RUNTIME_VERSION;

  let context: RuntimeContext;
  try {
    context = new RuntimeContext(options);
  } catch (error) {
    delete scope[VERSION_KEY];
    // Nothing has been wrapped yet, so the process is exactly as it was.
    console.warn(
      `[mycursor:${options.processLabel}] interception disabled: ${(error as Error).message}`,
    );
    return { installed: false, version: RUNTIME_VERSION, layers: [], reason: 'context-failed' };
  }

  scope[CONTEXT_KEY] = context;
  const enabled = context.config().interception.layers;
  const installedLayers: LayerName[] = [];

  for (const layer of LAYER_INSTALLERS) {
    if (!enabled[layer.name]) continue;
    try {
      layer.install(context);
      installedLayers.push(layer.name);
    } catch (error) {
      // A layer that cannot install is a reduction in coverage, not a failure:
      // the remaining layers still route traffic.
      context.logger.warn('layer failed to install', {
        layer: layer.name,
        error: (error as Error).message,
      });
    }
  }

  syncEsmExports();

  // Warm the readiness cache so the synchronous decision paths do not have to
  // hold the process's very first request.
  void context.uplink.refresh();

  context.logger.info('interception installed', {
    version: RUNTIME_VERSION,
    layers: installedLayers,
    byokMode: context.config().byokMode,
    rules: context.router().snapshot().rules,
    server: `${context.config().server.host}:${context.config().server.port}`,
  });

  return { installed: true, version: RUNTIME_VERSION, layers: installedLayers };
}

/** Returns the live runtime context, when one has been installed. */
export function currentContext(): RuntimeContext | null {
  const value = (globalThis as Record<string, unknown>)[CONTEXT_KEY];
  return value instanceof RuntimeContext ? value : null;
}

export { RuntimeContext } from './context.js';
export { VERSION_KEY, CONTEXT_KEY };
