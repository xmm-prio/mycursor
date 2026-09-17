/**
 * Sandbox install: the installer run against Cursor's real bundles.
 *
 * The interception matrix proves traffic goes where intended. This proves the
 * installer can get the payload into a real Cursor build and back out again
 * without damage — the other half of "does not break the environment".
 *
 * Nothing here touches the live installation. A shadow tree is built from
 * copies, `MYCURSOR_CURSOR_ROOT` points the locator at it, and
 * `MYCURSOR_HOME` redirects configuration and the install manifest into the
 * same throwaway directory.
 *
 * What is asserted, in order of how badly it would hurt to get wrong:
 *
 *  - every patched file is still valid JavaScript, checked with `node --check`
 *    against the file on disk;
 *  - uninstall restores every file to its original SHA-256;
 *  - a second install is a no-op, and a stale payload is replaced rather than
 *    stacked;
 *  - `product.json` checksums follow the files they describe.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig, saveConfigTo } from '@mycursor/core/config';
import {
  applyPlan,
  buildManifest,
  computeChecksum,
  discoverTargets,
  guardMarkerFor,
  inspectInstall,
  locateInstalls,
  planInstall,
  uninstallInstall,
  writeManifest,
} from '@mycursor/patcher';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const workDir = join(repoRoot, '.verify-out', 'sandbox');
const shadowRoot = join(workDir, 'app');
const configHome = join(workDir, 'home');

const { buildShadowTree, buildServerShadowTree, hashTree } = await import('./lib/shadow-tree.mjs');

/**
 * The SSH remote half.
 *
 * A remote workspace runs the headless server under `~/.cursor-server`, and
 * the payload has to reach it there or an agent running remotely talks
 * straight to the official API. That path cannot be exercised on a developer
 * machine by accident, which is exactly why it is worth building a shadow of
 * it: the locator and the patcher are supposed to treat it like any other
 * installation, and this is what proves they still do.
 */
async function verifyRemoteServerInstall(source, config, configPath) {
  console.log('\n── SSH remote: the headless server installation');
  const remoteHome = join(workDir, 'cursor-server');
  const shadow = buildServerShadowTree({ source, destination: remoteHome });
  const pristine = hashTree(shadow.serverRoot);

  // Only the server home is overridden, so the locator has to recognise the
  // layout rather than be told where to look.
  const env = { ...process.env, MYCURSOR_CURSOR_SERVER_HOME: remoteHome };
  delete env.MYCURSOR_CURSOR_ROOT;

  const located = locateInstalls(env);
  const remote = located.installs.find((install) => install.kind === 'server');
  check(
    'locator finds the headless server layout',
    Boolean(remote) && remote.root === shadow.serverRoot,
    remote ? `${remote.kind}@${remote.version}` : located.candidates.map((entry) => entry.status).join(','),
  );
  if (!remote) return;

  const plan = planInstall(remote);
  check(
    'the same discovery applies to a server install',
    plan.entries.length > 0 && plan.entries.every((entry) => entry.action === 'patch'),
    plan.entries.map((entry) => entry.target.id).join(', '),
  );

  const applied = applyPlan(plan, { config, configPath });
  check('remote install completed without rollback', applied.rolledBack === null, applied.rolledBack?.error);
  check(
    'the agent host was patched on the remote install',
    applied.patched.some((entry) => entry.target.id === 'extension:cursor-agent-host'),
    applied.patched.map((entry) => entry.target.id).join(', '),
  );

  for (const entry of applied.patched) {
    const { ok } = nodeSyntaxCheck(entry.target.file);
    if (!ok) {
      check(`remote ${entry.target.id} still parses`, false);
      return;
    }
  }
  check('every patched remote file still parses', true, `${applied.patched.length} file(s)`);

  const removal = uninstallInstall(remote);
  check('remote uninstall reported no failures', removal.failed.length === 0, JSON.stringify(removal.failed));

  const restored = hashTree(shadow.serverRoot);
  const mismatched = [...pristine].filter(([file, hash]) => restored.get(file) !== hash);
  check(
    'the remote install was restored byte for byte',
    mismatched.length === 0,
    mismatched.length === 0 ? `${pristine.size} files verified` : mismatched.map(([file]) => file).join(', '),
  );
}

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function sourceInstallRoot() {
  const override = process.env.MYCURSOR_SANDBOX_SOURCE;
  if (override) return override;
  // Locate the live installation without the sandbox override in effect.
  const env = { ...process.env };
  delete env.MYCURSOR_CURSOR_ROOT;
  const located = locateInstalls(env);
  const desktop = located.installs.find((install) => install.kind === 'desktop');
  if (!desktop) {
    console.error('No desktop Cursor installation found to copy from.');
    console.error('Set MYCURSOR_SANDBOX_SOURCE to an install root to run this verification.');
    process.exit(2);
  }
  return desktop.root;
}

function nodeSyntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
  return { ok: result.status === 0, stderr: (result.stderr ?? '').trim() };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main() {
  console.log('mycursor sandbox install verification');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const source = sourceInstallRoot();
  console.log(`source install: ${source}`);
  const shadow = buildShadowTree({ source, destination: shadowRoot });
  console.log(
    `shadow tree:    ${shadowRoot} (${shadow.copied.length} files, ${(shadow.totalBytes / 1048576).toFixed(1)} MiB, ${shadow.manifestsOnly} manifest-only extensions)`,
  );

  const pristine = hashTree(shadowRoot);
  console.log(`pristine hashes captured for ${pristine.size} files\n`);

  // The locator and the configuration root are both redirected, so this run
  // cannot read or write anything belonging to the live installation.
  const env = {
    ...process.env,
    MYCURSOR_CURSOR_ROOT: shadowRoot,
    MYCURSOR_HOME: configHome,
  };

  console.log('── Detection');
  const located = locateInstalls(env);
  check(
    'locator honours MYCURSOR_CURSOR_ROOT',
    located.installs.length === 1 && located.installs[0].root === shadowRoot,
    located.installs.map((install) => `${install.kind}@${install.version}`).join(', '),
  );
  const layout = located.installs[0];

  const discovery = discoverTargets(layout);
  const ids = discovery.targets.map((target) => target.id).sort();
  const expected = [
    'extension:cursor-agent-host',
    'node:alwaysLocalSingletonMain',
    'node:extensionHostProcess',
    'renderer:desktop',
    'renderer:glass',
  ];
  check(
    'discovery finds every network-bearing target by content',
    expected.every((id) => ids.includes(id)),
    ids.join(', '),
  );
  check(
    'discovery rejects extensions that carry no model traffic',
    !ids.some((id) => id.startsWith('extension:') && id !== 'extension:cursor-agent-host'),
    `${shadow.manifestsOnly} manifest-only extensions were skipped`,
  );

  console.log('\n── First install');
  const config = createDefaultConfig();
  const configPath = join(configHome, 'config.json');
  saveConfigTo(configPath, config);

  const plan = planInstall(layout);
  check(
    'plan marks every discovered target for patching',
    plan.entries.length > 0 && plan.entries.every((entry) => entry.action === 'patch'),
    `${plan.entries.length} targets`,
  );

  const applied = applyPlan(plan, { config, configPath, log: (line) => console.log(`    ${line}`) });
  check('apply completed without rollback', applied.rolledBack === null, applied.rolledBack?.error);
  check(
    'every target was patched',
    applied.patched.length === plan.entries.length,
    `${applied.patched.length}/${plan.entries.length}`,
  );

  writeManifest(configHome, buildManifest('0.1.0', [{ result: applied, productBackup: applied.checksums.backup }]));
  check('install manifest written', existsSync(join(configHome, 'install-manifest.json')));

  console.log('\n── Patched files remain valid JavaScript');
  for (const entry of applied.patched) {
    const { ok, stderr } = nodeSyntaxCheck(entry.target.file);
    check(
      `node --check ${entry.target.id}`,
      ok,
      ok ? `${(entry.target.sizeBytes / 1048576).toFixed(1)} MiB parses` : stderr.split('\n')[0],
    );
  }

  console.log('\n── Payload placement');
  for (const entry of applied.patched) {
    const source_ = readFileSync(entry.target.file, 'utf-8');
    const guard = guardMarkerFor(entry.target);
    const blocks = source_.split('MYCURSOR-INTERCEPTOR-BEGIN').length - 1;
    check(
      `${entry.target.id}: exactly one payload block, at the start`,
      blocks === 1 && source_.startsWith('/* MYCURSOR-INTERCEPTOR-BEGIN'),
      `blocks=${blocks}`,
    );
    check(
      `${entry.target.id}: payload carries its guard marker`,
      source_.slice(0, 262_144).includes(guard),
      guard,
    );
  }

  console.log('\n── product.json integrity metadata');
  const trackedKeys = applied.patched.filter((entry) => entry.target.checksumKey).map((entry) => entry.target.checksumKey);
  check(
    'checksums refreshed for tracked files only',
    applied.checksums.updated.every((update) => trackedKeys.includes(update.key)),
    applied.checksums.updated.map((update) => update.key).join(', ') || '(none needed)',
  );
  const product = JSON.parse(readFileSync(layout.productJson, 'utf-8'));
  for (const entry of applied.patched) {
    if (!entry.target.checksumKey) continue;
    const recorded = product.checksums?.[entry.target.checksumKey];
    if (recorded === undefined) continue;
    check(
      `checksum matches file for ${entry.target.checksumKey}`,
      recorded === computeChecksum(entry.target.file),
    );
  }

  console.log('\n── Idempotence');
  const secondPlan = planInstall(layout);
  check(
    'second plan reports everything current',
    secondPlan.satisfied && secondPlan.entries.every((entry) => entry.action === 'current'),
    secondPlan.entries.map((entry) => entry.action).join(','),
  );
  const secondApply = applyPlan(secondPlan, { config, configPath });
  check('second apply writes nothing', secondApply.patched.length === 0);

  const status = inspectInstall(layout);
  check('status reports a fully patched install', status.fullyPatched && !status.partiallyPatched);

  console.log('\n── Stale payload is replaced, not stacked');
  const staleTarget = applied.patched.find((entry) => entry.target.runtime === 'node').target;
  const staleSource = readFileSync(staleTarget.file, 'utf-8');
  writeFileSync(
    staleTarget.file,
    staleSource.replace('MYCURSOR-INTERCEPTOR-BEGIN v1', 'MYCURSOR-INTERCEPTOR-BEGIN v0'),
    'utf-8',
  );
  const refreshPlan = planInstall(layout);
  const refreshEntry = refreshPlan.entries.find((entry) => entry.target.id === staleTarget.id);
  check('stale payload is detected', refreshEntry?.action === 'refresh', refreshEntry?.reason);
  const refreshApply = applyPlan(refreshPlan, { config, configPath });
  check('refresh completed without rollback', refreshApply.rolledBack === null);
  const refreshed = readFileSync(staleTarget.file, 'utf-8');
  check(
    'refreshed file still holds exactly one payload block',
    refreshed.split('MYCURSOR-INTERCEPTOR-BEGIN').length - 1 === 1,
  );
  check('refreshed file still parses', nodeSyntaxCheck(staleTarget.file).ok);

  console.log('\n── Uninstall restores the installation byte for byte');
  const removal = uninstallInstall(layout);
  check('uninstall reported no failures', removal.failed.length === 0, JSON.stringify(removal.failed));
  const restored = hashTree(shadowRoot);
  const mismatched = [];
  for (const [file, hash] of pristine) {
    const now = restored.get(file);
    if (now !== hash) mismatched.push(file);
  }
  check(
    'every file matches its pristine SHA-256',
    mismatched.length === 0,
    mismatched.length === 0 ? `${pristine.size} files verified` : mismatched.join(', '),
  );
  const leftoverBackups = [...restored.keys()].filter((file) => file.endsWith('.mycursor-bak'));
  check('no backup files left behind', leftoverBackups.length === 0, leftoverBackups.join(', '));
  check(
    'uninstalled install reports itself unpatched',
    !inspectInstall(layout).fullyPatched && !inspectInstall(layout).partiallyPatched,
  );

  await verifyRemoteServerInstall(source, config, configPath);

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed checks:');
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail ?? ''}`);
    process.exitCode = 1;
  }
  console.log(`\nshadow tree left at ${shadowRoot} for inspection; "pnpm clean" removes it`);
}

await main();
