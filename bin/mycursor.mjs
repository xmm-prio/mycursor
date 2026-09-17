#!/usr/bin/env node
/**
 * `npx .` entry point.
 *
 * The point of this launcher is that one command has to be enough. Someone
 * who has just cloned the repository has not built anything, so if the
 * workspace is present but unbuilt it is built here rather than met with an
 * error telling them to run two more commands.
 *
 * Building is skipped entirely when the CLI is already compiled, which is the
 * case for a published package.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = join(root, 'packages', 'cli', 'dist', 'main.js');
const packagesDir = join(root, 'packages');

function run(command, args, label) {
  process.stderr.write(`[mycursor] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

/**
 * Newest modification time across everything the build reads.
 *
 * Returns 0 for a published package, which ships `dist` and no sources and
 * must therefore never try to rebuild.
 */
function newestSourceTime() {
  let newest = 0;
  const consider = (path) => {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      // A file that vanished mid-walk cannot make the build stale.
    }
  };

  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else consider(path);
    }
  };

  consider(join(root, 'pnpm-lock.yaml'));
  let packages;
  try {
    packages = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    walk(join(packagesDir, entry.name, 'src'));
    consider(join(packagesDir, entry.name, 'package.json'));
    consider(join(packagesDir, entry.name, 'build.mjs'));
  }
  return newest;
}

/**
 * Decides whether the compiled CLI can be used as it stands.
 *
 * Checking only that `dist` exists is not enough: after a `git pull` the
 * compiled output is still there but no longer matches the sources, so the
 * launcher would silently run the previous version — including the bug the
 * pull was meant to fix.
 */
function isBuildCurrent() {
  if (!existsSync(cliEntry)) return false;
  const sourceTime = newestSourceTime();
  if (sourceTime === 0) return true;
  return statSync(cliEntry).mtimeMs >= sourceTime;
}

function ensureBuilt() {
  if (isBuildCurrent()) return true;

  if (!existsSync(join(root, 'packages', 'cli', 'package.json'))) {
    process.stderr.write('[mycursor] this package does not contain the CLI sources\n');
    return false;
  }

  if (existsSync(cliEntry)) {
    process.stderr.write('[mycursor] sources are newer than the build; rebuilding\n');
  }

  // A fresh clone has no node_modules; install before building.
  if (!existsSync(join(root, 'node_modules'))) {
    const packageManager = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    if (!run(packageManager, ['install'], `installing dependencies with ${packageManager}…`)) {
      return false;
    }
  }

  const packageManager = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
  if (!run(packageManager, ['run', 'build'], 'building…')) return false;
  return existsSync(cliEntry);
}

if (!ensureBuilt()) {
  process.stderr.write('[mycursor] could not build the CLI; run "pnpm install && pnpm build"\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
