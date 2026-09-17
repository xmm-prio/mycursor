#!/usr/bin/env node
/**
 * `npx mycursor` entry point.
 *
 * The point of this launcher is that one command has to be enough. Someone
 * running `npx` has not built anything, so if the workspace is present but
 * unbuilt it is built here rather than met with an error telling them to run
 * two more commands.
 *
 * Building is skipped entirely when the CLI is already compiled, which is the
 * case for a published package.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = join(root, 'packages', 'cli', 'dist', 'main.js');

function run(command, args, label) {
  process.stderr.write(`[mycursor] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function ensureBuilt() {
  if (existsSync(cliEntry)) return true;

  if (!existsSync(join(root, 'packages', 'cli', 'package.json'))) {
    process.stderr.write('[mycursor] this package does not contain the CLI sources\n');
    return false;
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
