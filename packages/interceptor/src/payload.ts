/**
 * Composing and recognising the injectable payload.
 *
 * The installer needs three operations over a target file: add the payload,
 * detect whether it is already there, and take it away again. Keeping all three
 * next to the marker definitions means an uninstall can never be out of step
 * with an install — the same constants drive both.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RENDERER_VERSION } from './renderer/index.js';
import type { RendererOptions } from './renderer/state.js';
import { RUNTIME_VERSION } from './runtime/index.js';

const BEGIN_TAG = 'MYCURSOR-INTERCEPTOR-BEGIN';
const END_TAG = 'MYCURSOR-INTERCEPTOR-END';

/**
 * Opening marker without its comment terminator, because the version and the
 * process label are appended inside the same comment.
 */
export const PAYLOAD_BEGIN = `/* ${BEGIN_TAG}`;
export const PAYLOAD_END = `/* ${END_TAG} */`;

/**
 * Bytes scanned when looking for the payload.
 *
 * The payload is always prepended, so a bounded scan keeps detection cheap on
 * the multi-megabyte bundles this runs against.
 */
const DETECTION_WINDOW = 256 * 1024;

export interface PayloadOptions {
  /** Short label identifying the patched process, e.g. `agent-host`. */
  processLabel: string;
  /**
   * Per-target key set on `globalThis`, so `status` can tell which targets a
   * running process actually loaded rather than inferring it from the files.
   */
  guardMarker: string;
  /** Overrides the configuration path; used by the verification harness. */
  configPath?: string;
}

const bundleCache = new Map<string, string>();

/** Reads one of the bundles produced by `build.mjs`. */
function readBundle(fileName: string): string {
  const cached = bundleCache.get(fileName);
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, fileName), join(here, '..', 'dist', fileName)]) {
    try {
      const source = readFileSync(candidate, 'utf-8');
      bundleCache.set(fileName, source);
      return source;
    } catch {
      continue;
    }
  }
  throw new Error(
    `interception bundle ${fileName} is missing; run "pnpm --filter @mycursor/interceptor build" first`,
  );
}

export function readRuntimeBundle(): string {
  return readBundle('payload.runtime.cjs');
}

export function readRendererBundle(): string {
  return readBundle('payload.renderer.js');
}

/**
 * Returns the source to prepend to a target file.
 *
 * The whole payload sits inside one guarded expression: if the host turns out
 * not to be a CommonJS module — the only environment where the bundled
 * `require` calls resolve — the failure is reported and the file continues to
 * evaluate as though nothing had been added.
 */
export function buildPayload(options: PayloadOptions): string {
  return wrap({
    version: RUNTIME_VERSION,
    processLabel: options.processLabel,
    optionsKey: '__mycursorPayloadOptions',
    optionsValue: {
      processLabel: options.processLabel,
      guardMarker: options.guardMarker,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    },
    bundle: readRuntimeBundle(),
  });
}

/**
 * Returns the source to prepend to a renderer bundle.
 *
 * The renderer cannot read the configuration document, so the route table
 * travels inside the payload. It is a starting point rather than the source of
 * truth: the renderer subscribes to the local server for updates, so an edit
 * still takes effect without re-patching.
 */
export function buildRendererPayload(options: RendererOptions): string {
  return wrap({
    version: RENDERER_VERSION,
    processLabel: options.processLabel,
    optionsKey: '__mycursorRendererOptions',
    optionsValue: options,
    bundle: readRendererBundle(),
  });
}

/**
 * Wraps a bundle with its options and a guard.
 *
 * The bundle sits inside one guarded expression so that a host which cannot
 * run it — a renderer bundle loaded somewhere without `fetch`, or a Node
 * payload prepended to an ESM module where the bundled `require` calls do not
 * resolve — reports the problem and continues to evaluate as though nothing
 * had been added.
 */
function wrap(input: {
  version: number;
  processLabel: string;
  optionsKey: string;
  optionsValue: unknown;
  bundle: string;
}): string {
  const label = JSON.stringify(input.processLabel);
  return [
    `${PAYLOAD_BEGIN} v${input.version} ${input.processLabel} */`,
    '(function(){try{',
    `globalThis[${JSON.stringify(input.optionsKey)}]=${JSON.stringify(input.optionsValue)};`,
    input.bundle.trimEnd(),
    `}catch(__mycursorError){try{console.warn("[mycursor:"+${label}+"] payload inert: "+(__mycursorError&&__mycursorError.message||__mycursorError))}catch(__){}}})();`,
    PAYLOAD_END,
    '',
  ].join('\n');
}

/** True when `source` already carries a payload for `guardMarker`. */
export function hasPayload(source: string, guardMarker?: string): boolean {
  const head = source.slice(0, DETECTION_WINDOW);
  if (!head.includes(PAYLOAD_BEGIN) || !head.includes(PAYLOAD_END)) return false;
  return guardMarker ? head.includes(guardMarker) : true;
}

/** True when the payload present in `source` is older than this build. */
export function hasStalePayload(source: string, guardMarker?: string): boolean {
  if (!hasPayload(source, guardMarker)) return false;
  return !source.slice(0, DETECTION_WINDOW).includes(`${BEGIN_TAG} v${RUNTIME_VERSION} `);
}

/**
 * Removes every payload block from `source`.
 *
 * Used by `uninstall` as a fallback when a backup is missing, and by `install`
 * to replace a stale payload without stacking a second copy on top of it.
 */
export function stripPayload(source: string): { source: string; removed: number } {
  let result = source;
  let removed = 0;
  for (;;) {
    const start = result.indexOf(PAYLOAD_BEGIN);
    if (start === -1) break;
    const end = result.indexOf(PAYLOAD_END, start);
    if (end === -1) break;
    let cut = end + PAYLOAD_END.length;
    if (result[cut] === '\n') cut += 1;
    result = result.slice(0, start) + result.slice(cut);
    removed += 1;
  }
  return { source: result, removed };
}
