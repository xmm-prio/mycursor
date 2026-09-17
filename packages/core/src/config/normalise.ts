/**
 * Turns an arbitrary parsed JSON value into a complete {@link MyCursorConfig}.
 *
 * Normalisation never throws and never returns a partial document: an unknown
 * or malformed field falls back to its default and is reported as a warning.
 * That property is what lets the interceptor keep running against a
 * hand-edited configuration file instead of silently disabling itself.
 */

import { createDefaultConfig } from './defaults.js';
import type {
  Endpoint,
  MyCursorConfig,
  ReadinessStrategy,
  ServerEndpoint,
  UplinkMode,
  UpstreamPolicy,
  WebSocketPolicy,
} from './types.js';

type Unknown = Record<string, unknown>;

const asObject = (value: unknown): Unknown =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Unknown) : {};

function pickBoolean(source: Unknown, key: string, fallback: boolean, warnings: string[]): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  // Accept the 0/1 encoding used by older documents.
  if (value === 0 || value === 1) return value === 1;
  warnings.push(`${key}: expected boolean, using default ${fallback}`);
  return fallback;
}

function pickString(source: Unknown, key: string, fallback: string, warnings: string[]): string {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string') return value.trim();
  warnings.push(`${key}: expected string, using default`);
  return fallback;
}

function pickPort(source: Unknown, key: string, fallback: number, warnings: string[]): number {
  const value = source[key];
  if (value === undefined) return fallback;
  const port = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) return port;
  warnings.push(`${key}: expected a TCP port, using default ${fallback}`);
  return fallback;
}

function pickHost(source: Unknown, key: string, fallback: string, warnings: string[]): string {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim()) return value.trim();
  warnings.push(`${key}: expected a non-empty host, using default ${fallback}`);
  return fallback;
}

function pickNumber(
  source: Unknown,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
  warnings: string[],
): number {
  const value = source[key];
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max) {
    return parsed;
  }
  warnings.push(
    `${key}: expected a number in [${bounds.min}, ${bounds.max}], using default ${fallback}`,
  );
  return fallback;
}

function pickEnum<T extends string>(
  source: Unknown,
  key: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  warnings.push(`${key}: expected one of ${allowed.join('|')}, using default ${fallback}`);
  return fallback;
}

function pickStringList(
  source: Unknown,
  key: string,
  fallback: string[],
  warnings: string[],
): string[] {
  const value = source[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    warnings.push(`${key}: expected an array of strings, using default`);
    return [...fallback];
  }
  const list = value.filter((entry): entry is string => typeof entry === 'string');
  if (list.length !== value.length) {
    warnings.push(`${key}: dropped ${value.length - list.length} non-string entry/entries`);
  }
  return list;
}

function pickEndpoint(
  source: Unknown,
  key: string,
  fallback: Endpoint,
  warnings: string[],
): Endpoint {
  const raw = asObject(source[key]);
  return {
    host: pickHost(raw, 'host', fallback.host, warnings),
    port: pickPort(raw, 'port', fallback.port, warnings),
  };
}

function pickServerEndpoint(
  source: Unknown,
  key: string,
  fallback: ServerEndpoint,
  warnings: string[],
): ServerEndpoint {
  const raw = asObject(source[key]);
  const port = pickPort(raw, 'port', fallback.port, warnings);
  // A TLS port that collides with the plaintext port would make the listener
  // fail to bind, so derive a safe neighbour instead of propagating the clash.
  let tlsPort = pickPort(raw, 'tlsPort', port === fallback.port ? fallback.tlsPort : port + 1, warnings);
  if (tlsPort === port) {
    tlsPort = port + 1;
    warnings.push(`${key}.tlsPort: must differ from port, using ${tlsPort}`);
  }
  return { host: pickHost(raw, 'host', fallback.host, warnings), port, tlsPort };
}

export function normaliseConfig(input: unknown): { config: MyCursorConfig; warnings: string[] } {
  const warnings: string[] = [];
  const defaults = createDefaultConfig();
  const root = asObject(input);

  const interceptionRaw = asObject(root['interception']);
  const layersRaw = asObject(interceptionRaw['layers']);
  const readinessRaw = asObject(interceptionRaw['readiness']);
  const uplinkRaw = asObject(root['uplink']);
  const upstreamRaw = asObject(root['upstream']);
  const toolsRaw = asObject(root['tools']);
  const webSearchRaw = asObject(root['webSearch']);

  const config: MyCursorConfig = {
    $schemaVersion: pickNumber(
      root,
      '$schemaVersion',
      defaults.$schemaVersion,
      { min: 1, max: 1_000 },
      warnings,
    ),
    byokMode: pickBoolean(root, 'byokMode', defaults.byokMode, warnings),
    server: pickServerEndpoint(root, 'server', defaults.server, warnings),
    collector: pickEndpoint(root, 'collector', defaults.collector, warnings),
    uplink: {
      mode: pickEnum<UplinkMode>(
        uplinkRaw,
        'mode',
        ['local', 'tunnel', 'auto'],
        defaults.uplink.mode,
        warnings,
      ),
      tunnel: pickServerEndpoint(uplinkRaw, 'tunnel', defaults.uplink.tunnel, warnings),
      probeTtlSeconds: pickNumber(
        uplinkRaw,
        'probeTtlSeconds',
        defaults.uplink.probeTtlSeconds,
        { min: 1, max: 3_600 },
        warnings,
      ),
      probeTimeoutMs: pickNumber(
        uplinkRaw,
        'probeTimeoutMs',
        defaults.uplink.probeTimeoutMs,
        { min: 50, max: 10_000 },
        warnings,
      ),
    },
    interception: {
      layers: {
        http1: pickBoolean(layersRaw, 'http1', defaults.interception.layers.http1, warnings),
        http2: pickBoolean(layersRaw, 'http2', defaults.interception.layers.http2, warnings),
        fetch: pickBoolean(layersRaw, 'fetch', defaults.interception.layers.fetch, warnings),
        socket: pickBoolean(layersRaw, 'socket', defaults.interception.layers.socket, warnings),
        websocket: pickBoolean(
          layersRaw,
          'websocket',
          defaults.interception.layers.websocket,
          warnings,
        ),
        dns: pickBoolean(layersRaw, 'dns', defaults.interception.layers.dns, warnings),
      },
      readiness: {
        strategy: pickEnum<ReadinessStrategy>(
          readinessRaw,
          'strategy',
          ['hold', 'passthrough'],
          defaults.interception.readiness.strategy,
          warnings,
        ),
        maxWaitMs: pickNumber(
          readinessRaw,
          'maxWaitMs',
          defaults.interception.readiness.maxWaitMs,
          { min: 0, max: 120_000 },
          warnings,
        ),
        retryDelayMs: pickNumber(
          readinessRaw,
          'retryDelayMs',
          defaults.interception.readiness.retryDelayMs,
          { min: 10, max: 10_000 },
          warnings,
        ),
        cacheTtlSeconds: pickNumber(
          readinessRaw,
          'cacheTtlSeconds',
          defaults.interception.readiness.cacheTtlSeconds,
          { min: 0, max: 600 },
          warnings,
        ),
      },
      websocketPolicy: pickEnum<WebSocketPolicy>(
        interceptionRaw,
        'websocketPolicy',
        ['route', 'downgrade', 'ignore'],
        defaults.interception.websocketPolicy,
        warnings,
      ),
      hostPatterns: pickStringList(
        interceptionRaw,
        'hostPatterns',
        defaults.interception.hostPatterns,
        warnings,
      ),
      verbose: pickBoolean(interceptionRaw, 'verbose', defaults.interception.verbose, warnings),
    },
    upstream: {
      policy: pickEnum<UpstreamPolicy>(
        upstreamRaw,
        'policy',
        ['proxy', 'reject'],
        defaults.upstream.policy,
        warnings,
      ),
      port: pickPort(upstreamRaw, 'port', defaults.upstream.port, warnings),
      timeoutMs: pickNumber(
        upstreamRaw,
        'timeoutMs',
        defaults.upstream.timeoutMs,
        { min: 1_000, max: 600_000 },
        warnings,
      ),
      retries: pickNumber(upstreamRaw, 'retries', defaults.upstream.retries, { min: 0, max: 5 }, warnings),
    },
    tools: {
      preserveNative: pickBoolean(toolsRaw, 'preserveNative', defaults.tools.preserveNative, warnings),
      allowAugmentation: pickBoolean(
        toolsRaw,
        'allowAugmentation',
        defaults.tools.allowAugmentation,
        warnings,
      ),
      augmentationDenyList: pickStringList(
        toolsRaw,
        'augmentationDenyList',
        defaults.tools.augmentationDenyList,
        warnings,
      ),
      nativeAllowList: pickStringList(
        toolsRaw,
        'nativeAllowList',
        defaults.tools.nativeAllowList,
        warnings,
      ),
    },
    webSearch: {
      enabled: pickBoolean(webSearchRaw, 'enabled', defaults.webSearch.enabled, warnings),
      backend: pickString(webSearchRaw, 'backend', defaults.webSearch.backend, warnings),
      apiKey: pickString(webSearchRaw, 'apiKey', defaults.webSearch.apiKey, warnings),
      maxResults: pickNumber(
        webSearchRaw,
        'maxResults',
        defaults.webSearch.maxResults,
        { min: 1, max: 20 },
        warnings,
      ),
      allowFetch: pickBoolean(webSearchRaw, 'allowFetch', defaults.webSearch.allowFetch, warnings),
      proxyUrl: pickString(webSearchRaw, 'proxyUrl', defaults.webSearch.proxyUrl, warnings),
    },
    redirect: pickStringList(root, 'redirect', defaults.redirect, warnings),
  };

  if (config.interception.hostPatterns.length === 0) {
    config.interception.hostPatterns = [...defaults.interception.hostPatterns];
    warnings.push('interception.hostPatterns: empty list would capture nothing, restored defaults');
  }

  return { config, warnings };
}
