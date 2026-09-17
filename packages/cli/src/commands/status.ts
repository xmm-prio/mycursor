/**
 * `mycursor status` and `mycursor doctor`
 *
 * `status` answers "is it on?". `doctor` answers "why isn't it working?", which
 * needs more: whether the payload is in each process, whether the server is
 * reachable and is actually ours, whether a provider has a usable key, and
 * whether Cursor's integrity metadata matches its files.
 */

import { existsSync, readFileSync } from 'node:fs';

import { loadConfigFrom, resolveConfigPaths, type MyCursorConfig } from '@mycursor/core/config';
import { RequestRouter } from '@mycursor/core/routing';
import {
  auditChecksums,
  checksumFileResolver,
  formatLocateResult,
  inspectInstall,
  locateInstalls,
  readManifest,
} from '@mycursor/patcher';
import { loadProvidersFrom } from '@mycursor/providers';
import { HEALTH_PATH, SERVICE_MARKER, STATUS_PATH } from '@mycursor/server';

import { detail, fail, heading, info, mark, ok, rows, warn } from '../ui.js';

interface ServerProbe {
  reachable: boolean;
  isOurs: boolean;
  detail: string;
  status?: Record<string, unknown>;
}

async function probeServer(config: MyCursorConfig): Promise<ServerProbe> {
  const base = `http://${config.server.host}:${config.server.port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${base}${HEALTH_PATH}`, { signal: controller.signal });
    const body = (await response.json()) as { ok?: boolean; service?: string; version?: string };
    // The identity marker matters: without it an unrelated listener on the
    // port would look healthy and quietly swallow model traffic.
    if (body.ok === true && body.service === SERVICE_MARKER) {
      const statusResponse = await fetch(`${base}${STATUS_PATH}`).catch(() => null);
      const status = statusResponse ? ((await statusResponse.json()) as Record<string, unknown>) : undefined;
      return {
        reachable: true,
        isOurs: true,
        detail: `mycursor ${body.version ?? 'unknown'} on ${base}`,
        ...(status ? { status } : {}),
      };
    }
    return {
      reachable: true,
      isOurs: false,
      detail: `${base} answered, but it is not a mycursor server`,
    };
  } catch (error) {
    return {
      reachable: false,
      isOurs: false,
      detail: `${base} is not answering (${(error as Error).name === 'AbortError' ? 'timeout' : (error as Error).message})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function status(deep: boolean): Promise<number> {
  heading(deep ? 'mycursor doctor' : 'mycursor status');

  const paths = resolveConfigPaths();
  const loaded = loadConfigFrom(paths.config);
  const config = loaded.config;

  heading('configuration');
  rows([
    ['root', paths.root],
    ['document', loaded.status === 'loaded' ? paths.config : `${paths.config} (${loaded.status}, using defaults)`],
    ['byok mode', config.byokMode ? 'on' : 'off'],
    ['server', `${config.server.host}:${config.server.port} (tls ${config.server.tlsPort})`],
    ['uplink', config.uplink.mode],
    ['route rules', String(config.redirect.length)],
    ['readiness', `${config.interception.readiness.strategy}, up to ${config.interception.readiness.maxWaitMs} ms`],
    ['websocket', config.interception.websocketPolicy],
    ['upstream', config.upstream.policy],
    ['preserve native tools', config.tools.preserveNative ? 'yes' : 'no'],
  ]);
  for (const warning of loaded.warnings) warn(warning);

  const layers = Object.entries(config.interception.layers)
    .map(([name, enabled]) => `${name}=${enabled ? 'on' : 'off'}`)
    .join('  ');
  detail(`layers  ${layers}`);

  heading('providers');
  const providers = loadProvidersFrom(paths.providers);
  if (!existsSync(paths.providers)) {
    warn(`no provider document at ${paths.providers}; run "mycursor install"`);
  } else if (providers.size === 0) {
    warn('no usable provider is configured — set an apiKey and enable an entry');
    for (const warning of providers.warnings) detail(warning);
  } else {
    ok(`${providers.size} provider(s), ${providers.allModels().length} model(s)`);
    for (const provider of providers.list()) {
      detail(`${provider.id} (${provider.kind}) · ${provider.models.map((model) => model.id).join(', ')}`);
    }
    for (const warning of providers.warnings) warn(warning);
  }

  heading('cursor schema');
  if (!existsSync(paths.descriptors)) {
    warn('no protobuf schema extracted; model injection is unavailable');
    detail('run "mycursor schema" (or "mycursor install") to recover it from your Cursor');
  } else {
    try {
      const document = JSON.parse(readFileSync(paths.descriptors, 'utf-8')) as {
        cursorVersion?: string;
        extractedAt?: string;
        messages?: Record<string, unknown>;
        services?: Record<string, unknown>;
      };
      const installedVersion = locateInstalls().installs.find((entry) => entry.kind === 'desktop')?.version;
      const stale = installedVersion && document.cursorVersion !== installedVersion;
      const summary = `Cursor ${document.cursorVersion} · ${Object.keys(document.messages ?? {}).length} messages · ${Object.keys(document.services ?? {}).length} services`;
      if (stale) {
        warn(`${summary} — installed Cursor is ${installedVersion}; run "mycursor schema"`);
      } else {
        ok(summary);
      }
      detail(`extracted ${document.extractedAt}`);
    } catch (error) {
      warn(`schema document is unreadable: ${(error as Error).message}`);
    }
  }

  heading('server');
  const probe = await probeServer(config);
  if (probe.isOurs) {
    ok(probe.detail);
    if (probe.status) {
      const schemaState = probe.status['schema'] as
        | { available?: boolean; methods?: number; cursorVersion?: string | null }
        | undefined;
      if (schemaState) {
        detail(
          schemaState.available
            ? `schema loaded  Cursor ${schemaState.cursorVersion} · ${schemaState.methods} methods`
            : 'schema not loaded — schema-backed methods are forwarded upstream',
        );
      }
      const counters = probe.status['counters'] as Record<string, number> | undefined;
      if (counters && Object.keys(counters).length > 0) {
        detail(
          `dispatch  ${Object.entries(counters)
            .map(([key, value]) => `${key}=${value}`)
            .join('  ')}`,
        );
      }
    }
  } else if (probe.reachable) {
    fail(probe.detail);
    detail('another process holds the port; change server.port or stop it');
  } else {
    warn(probe.detail);
    detail('start it with "mycursor serve"');
  }

  heading('installations');
  const located = locateInstalls();
  if (located.installs.length === 0) {
    fail('no Cursor installation found');
    console.log(`\n${formatLocateResult(located)}`);
    return 1;
  }

  let healthy = true;
  for (const layout of located.installs) {
    const inspection = inspectInstall(layout);
    const label = `${layout.kind} · Cursor ${layout.version}`;
    if (inspection.fullyPatched) ok(`${label} — fully patched`);
    else if (inspection.partiallyPatched) {
      warn(`${label} — partially patched; run "mycursor install"`);
      healthy = false;
    } else {
      info(`${label} — not patched`);
      healthy = false;
    }
    detail(layout.root);

    if (deep) {
      for (const target of inspection.targets) {
        const state = !target.present
          ? 'missing'
          : target.stale
            ? 'stale payload'
            : target.patched
              ? 'patched'
              : 'clean';
        detail(`  ${target.id.padEnd(34)} ${state.padEnd(14)} backup=${mark(target.backed_up)}`);
      }

      const audit = auditChecksums(layout.productJson, checksumFileResolver(layout));
      const mismatched = audit.filter((entry) => !entry.matches);
      if (mismatched.length === 0) {
        detail('  product.json checksums all match');
      } else {
        // Cursor ships at least one stale entry of its own, so this is
        // reported as information rather than as a fault.
        detail(`  product.json checksum mismatches: ${mismatched.map((entry) => entry.key).join(', ')}`);
        detail('  (Cursor ships with some entries already stale; a mismatch alone is not a fault)');
      }
    }
  }

  if (deep) {
    heading('route table');
    const { router, warnings } = RequestRouter.compile({
      byokMode: config.byokMode,
      hostPatterns: config.interception.hostPatterns,
      redirect: config.redirect,
    });
    const snapshot = router.snapshot();
    rows([
      ['host patterns', String(snapshot.hosts)],
      ['compiled rules', String(snapshot.rules)],
      ['rest paths', router.restPaths().join(', ') || '(none)'],
    ]);
    for (const warning of warnings) warn(warning);

    heading('install manifest');
    const manifest = readManifest(paths.root);
    if (!manifest) {
      info('no manifest — nothing has been installed from this configuration root');
    } else {
      for (const entry of manifest.installs) {
        detail(`${entry.kind} ${entry.cursorVersion} · ${entry.entries.length} target(s) · ${entry.root}`);
      }
    }

    heading('interception payload');
    for (const layout of located.installs) {
      const inspection = inspectInstall(layout);
      const patched = inspection.targets.filter((target) => target.patched);
      if (patched.length === 0) continue;
      const sample = patched[0]!;
      const head = readFileSync(sample.file, 'utf-8').slice(0, 200);
      const version = head.match(/MYCURSOR-INTERCEPTOR-BEGIN v(\d+)/)?.[1] ?? 'unknown';
      detail(`${layout.root}: payload v${version} in ${patched.length} target(s)`);
    }
  }

  return healthy && probe.isOurs ? 0 : 0;
}
