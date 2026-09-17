/**
 * `mycursor extension`
 *
 * Packages the sidebar panel as a VSIX and installs it through Cursor's own
 * CLI. Folding this into the installer is what lets a single command leave the
 * user with a working panel instead of a checklist.
 *
 * The extension is installed as an ordinary user extension. It is deliberately
 * not placed among Cursor's built-ins: doing so would require defeating
 * signature verification, which is a far more invasive change than anything
 * else this toolkit does.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfigPaths } from '@mycursor/core/config';
import {
  findCursorCli,
  installVsix,
  locateInstalls,
  packExtension,
  uninstallExtension,
} from '@mycursor/patcher';

import { detail, fail, heading, info, ok, warn } from '../ui.js';

export interface ExtensionFlags {
  /** Build the VSIX but do not install it. */
  packOnly: boolean;
  /** Remove the extension instead of installing it. */
  remove: boolean;
}

/**
 * Finds the built extension directory.
 *
 * Two layouts have to work: running from the repository, and running from an
 * installed package where the extension was published alongside the CLI.
 */
function findExtensionRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Published layout: the extension ships inside this package.
    resolve(here, '..', 'extension'),
    resolve(here, '..', '..', 'extension'),
    // Repository layout: a sibling workspace package.
    resolve(here, '..', '..', '..', 'extension'),
    resolve(here, '..', '..', '..', '..', 'packages', 'extension'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'dist'))) {
      return candidate;
    }
  }
  return null;
}

function readIdentifier(extensionRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf-8')) as {
    name: string;
    publisher: string;
    vsix?: { name?: string; publisher?: string };
  };
  // Must match what `packExtension` writes, or uninstall targets nothing.
  const name = manifest.vsix?.name ?? manifest.name.replace(/^@[^/]+\//, '');
  return `${manifest.vsix?.publisher ?? manifest.publisher}.${name}`;
}

export async function extension(flags: ExtensionFlags): Promise<number> {
  heading('mycursor extension');

  const extensionRoot = findExtensionRoot();
  if (!extensionRoot) {
    fail('built extension not found');
    detail('run "pnpm build" first, or install a package that bundles the extension');
    return 1;
  }
  info(extensionRoot);

  const install = locateInstalls().installs.find((entry) => entry.kind === 'desktop');
  const cli = findCursorCli(install?.root);

  if (flags.remove) {
    if (!cli) {
      fail('Cursor CLI not found; cannot uninstall the extension');
      return 1;
    }
    const identifier = readIdentifier(extensionRoot);
    const result = uninstallExtension(identifier, cli);
    if (result.ok) {
      ok(`removed ${identifier}`);
      return 0;
    }
    warn(`could not remove ${identifier}`);
    if (result.output) detail(result.output);
    return 1;
  }

  const outputPath = join(resolveConfigPaths().root, 'extension', 'mycursor.vsix');
  mkdirSync(dirname(outputPath), { recursive: true });

  let packed;
  try {
    packed = packExtension(extensionRoot, outputPath);
  } catch (error) {
    fail(`packaging failed: ${(error as Error).message}`);
    return 1;
  }
  ok(`packaged ${packed.identifier} (${packed.entries} files, ${(packed.bytes / 1024).toFixed(0)} KiB)`);
  detail(packed.vsixPath);

  if (flags.packOnly) {
    info('--pack-only: not installing');
    return 0;
  }

  if (!cli) {
    warn('Cursor CLI not found; install the package by hand');
    detail(`cursor --install-extension "${packed.vsixPath}" --force`);
    return 1;
  }

  const result = installVsix(packed.vsixPath, cli);
  if (!result.ok) {
    fail('Cursor refused the extension');
    if (result.output) detail(result.output);
    detail(`retry by hand: cursor --install-extension "${packed.vsixPath}" --force`);
    return 1;
  }

  ok(`installed ${packed.identifier}`);
  if (result.output) detail(result.output.split('\n').slice(-1)[0] ?? '');
  detail('the MyCursor panel appears in the activity bar after Cursor restarts');
  return 0;
}
