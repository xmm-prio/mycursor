/**
 * `mycursor install`
 *
 * Patches every Cursor installation on this machine — the desktop application
 * and any headless server under `~/.cursor-server`, because an SSH remote
 * workspace runs the latter and needs the payload there too.
 *
 * The command is safe to re-run: the plan reports what is already current, and
 * a failure anywhere rolls the whole installation back rather than leaving
 * some processes routed and others not.
 */

import { existsSync } from 'node:fs';

import {
  createDefaultConfig,
  loadConfigFrom,
  resolveConfigPaths,
  saveConfigTo,
} from '@mycursor/core/config';
import {
  applyPlan,
  buildManifest,
  formatLocateResult,
  locateInstalls,
  planInstall,
  writeManifest,
} from '@mycursor/patcher';
import { createExampleProviders, saveProvidersTo } from '@mycursor/providers';

import { extension } from './extension.js';
import { schema } from './schema.js';
import { detail, fail, heading, info, ok, rows, warn } from '../ui.js';

export interface InstallFlags {
  /** Re-apply the payload even where it is already current. */
  force: boolean;
  /** Report what would happen and write nothing. */
  dryRun: boolean;
  /** Patch and extract the schema, but leave the panel extension alone. */
  skipExtension: boolean;
}

export async function install(flags: InstallFlags): Promise<number> {
  heading('mycursor install');

  const located = locateInstalls();
  if (located.installs.length === 0) {
    fail('no Cursor installation found');
    console.log(`\n${formatLocateResult(located)}`);
    return 1;
  }

  const paths = resolveConfigPaths();
  const existing = loadConfigFrom(paths.config);
  const config = existing.status === 'loaded' ? existing.config : createDefaultConfig();

  if (existing.status !== 'loaded') {
    saveConfigTo(paths.config, config);
    ok(`wrote default configuration to ${paths.config}`);
  } else {
    info(`using existing configuration ${paths.config}`);
  }

  if (!existsSync(paths.providers)) {
    saveProvidersTo(paths.providers, createExampleProviders());
    ok(`wrote provider template to ${paths.providers}`);
    detail('edit it and set an apiKey before the first prompt');
  }

  // Extracting the schema is part of installing: without it the server can
  // only forward Cursor's own RPC methods, so a model would never appear in
  // the picker and the install would look like it had not worked.
  if (!flags.dryRun) {
    heading('cursor schema');
    const schemaCode = await schema({ dryRun: false, force: flags.force });
    if (schemaCode !== 0) {
      warn('schema extraction did not succeed; model injection will be unavailable');
      detail('the toolkit still routes traffic and forwards what it cannot answer');
    }
  }

  // The panel is how the user configures providers, and it is what starts the
  // server when a window opens, so installing it is part of a working setup
  // rather than an optional extra.
  if (!flags.dryRun && !flags.skipExtension) {
    const extensionCode = await extension({ packOnly: false, remove: false });
    if (extensionCode !== 0) {
      warn('the panel extension was not installed; the CLI still works');
      detail('retry with "mycursor extension"');
    }
  }

  const results: { result: ReturnType<typeof applyPlan>; productBackup: string | null }[] = [];
  let failures = 0;

  for (const layout of located.installs) {
    heading(`${layout.kind} install · Cursor ${layout.version}`);
    info(layout.root);

    const plan = planInstall(layout);
    if (plan.entries.length === 0) {
      warn('no patch targets discovered; this build may have moved its bundles');
      failures += 1;
      continue;
    }

    for (const entry of plan.entries) {
      detail(`${entry.action.padEnd(7)} ${entry.target.id} — ${entry.reason}`);
    }

    if (plan.satisfied && !flags.force) {
      ok('already fully patched');
      continue;
    }

    if (flags.dryRun) {
      info('dry run: nothing was written');
      continue;
    }

    const effectivePlan = flags.force
      ? { ...plan, entries: plan.entries.map((entry) => ({ ...entry, action: 'refresh' as const })) }
      : plan;

    const applied = applyPlan(effectivePlan, {
      config,
      configPath: paths.config,
      log: (message) => detail(message),
    });

    if (applied.rolledBack) {
      fail(`rolled back: ${applied.rolledBack.failedTarget} — ${applied.rolledBack.error}`);
      detail('the installation was restored and is unmodified');
      failures += 1;
      continue;
    }

    ok(`patched ${applied.patched.length} target(s)`);
    if (applied.checksums.updated.length > 0) {
      detail(`refreshed ${applied.checksums.updated.length} product.json checksum(s)`);
    }
    results.push({ result: applied, productBackup: applied.checksums.backup });
  }

  if (!flags.dryRun && results.length > 0) {
    const manifestPath = writeManifest(paths.root, buildManifest('0.1.0', results));
    detail(`manifest ${manifestPath}`);
  }

  heading('next steps');
  rows([
    ['1.', 'restart Cursor'],
    ['2.', 'open the MyCursor icon in the activity bar'],
    ['3.', 'add a provider, paste your key, press ↓ Fetch, then Save'],
    ['', ''],
    ['the server', 'starts with Cursor; "mycursor serve" runs it by hand'],
    ['after a Cursor upgrade', 'mycursor install (re-patches, re-extracts, re-installs)'],
    ['undo', 'mycursor uninstall'],
  ]);

  return failures > 0 ? 1 : 0;
}
