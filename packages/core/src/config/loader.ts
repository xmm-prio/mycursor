/**
 * Reading and writing the configuration document.
 *
 * Reads are synchronous because the interceptor runtime loads configuration at
 * module scope, before the patched process has an event loop turn to spare.
 * Writes go through a temporary file and a rename so a concurrent reader never
 * observes a half-written document.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createDefaultConfig } from './defaults.js';
import { normaliseConfig } from './normalise.js';
import { resolveConfigPaths } from './paths.js';
import type { ConfigLoadResult, MyCursorConfig } from './types.js';

/**
 * Loads and normalises the configuration document.
 *
 * A missing file yields defaults; an unreadable or invalid file also yields
 * defaults plus a warning. The function never throws, so a broken file degrades
 * behaviour rather than taking the host process down with it.
 */
export function loadConfigFrom(path: string): ConfigLoadResult {
  if (!existsSync(path)) {
    return { status: 'absent', config: createDefaultConfig(), source: null, warnings: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return {
      status: 'invalid',
      config: createDefaultConfig(),
      source: null,
      warnings: [`unreadable config ${path}: ${(error as Error).message}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: 'invalid',
      config: createDefaultConfig(),
      source: null,
      warnings: [`invalid JSON in ${path}: ${(error as Error).message}`],
    };
  }
  const { config, warnings } = normaliseConfig(parsed);
  return { status: 'loaded', config, source: path, warnings };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoadResult {
  return loadConfigFrom(resolveConfigPaths(env).config);
}

/** Writes a configuration document atomically, creating the directory if needed. */
export function saveConfigTo(path: string, config: MyCursorConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

export function saveConfig(config: MyCursorConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = resolveConfigPaths(env).config;
  saveConfigTo(path, config);
  return path;
}
