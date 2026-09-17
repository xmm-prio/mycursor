/**
 * Finding Cursor installations on the current machine.
 *
 * Every candidate that was examined is reported, not just the winner, because
 * "Cursor not found" is the single most common installation failure and a bare
 * error message leaves the user with nothing to act on.
 *
 * Remote server installations are enumerated too. Running the same installer on
 * a remote host is what makes an SSH workspace work: the interceptor there
 * reaches the developer's BYOK server through a forwarded port.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { buildLayout, isInstallRoot, type InstallKind, type InstallLayout } from './layout.js';

export const ROOT_ENV_VAR = 'MYCURSOR_CURSOR_ROOT';

/**
 * Overrides where headless server installations are looked for.
 *
 * `~/.cursor-server` is the default, but the directory is relocatable on hosts
 * with a non-standard home, and pointing the locator elsewhere is the only way
 * to exercise the remote path without a second machine.
 */
export const SERVER_HOME_ENV_VAR = 'MYCURSOR_CURSOR_SERVER_HOME';

export interface CandidateReport {
  path: string;
  kind: InstallKind;
  status: 'ok' | 'missing' | 'incomplete' | 'env-override';
}

export interface LocateResult {
  installs: InstallLayout[];
  candidates: CandidateReport[];
  platform: string;
  hint?: string;
}

function desktopCandidates(): string[] {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return [
        '/Applications/Cursor.app/Contents/Resources/app',
        join(home, 'Applications/Cursor.app/Contents/Resources/app'),
      ];
    case 'linux':
      return [
        '/opt/Cursor/resources/app',
        '/opt/cursor/resources/app',
        '/usr/share/cursor/resources/app',
        '/usr/lib/cursor/resources/app',
        join(home, '.local/share/cursor/resources/app'),
      ];
    case 'win32': {
      const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
      const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
      return [
        join(localAppData, 'Programs', 'cursor', 'resources', 'app'),
        join(programFiles, 'Cursor', 'resources', 'app'),
        join(programFilesX86, 'Cursor', 'resources', 'app'),
        join(home, 'scoop', 'apps', 'cursor', 'current', 'resources', 'app'),
      ];
    }
    default:
      return [];
  }
}

/**
 * Enumerates headless server installations under `~/.cursor-server`.
 *
 * Cursor keeps one directory per version, so several can coexist; all of them
 * are returned and the caller patches each, because the client decides which
 * to launch.
 */
function serverCandidates(env: NodeJS.ProcessEnv): string[] {
  const override = env[SERVER_HOME_ENV_VAR]?.trim();
  const base = override || join(homedir(), '.cursor-server');
  const roots: string[] = [];
  const listChildren = (directory: string): string[] => {
    if (!existsSync(directory)) return [];
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name));
    } catch {
      return [];
    }
  };

  for (const versionDir of listChildren(join(base, 'cli', 'servers'))) {
    roots.push(join(versionDir, 'server'));
  }
  // Older layouts place the server directly under `bin/<commit>`.
  roots.push(...listChildren(join(base, 'bin')));
  return roots;
}

/**
 * Locates every installation worth patching.
 *
 * `MYCURSOR_CURSOR_ROOT` takes precedence and suppresses the search entirely,
 * which is how the sandbox verification points the installer at a throwaway
 * copy instead of the live application.
 */
export function locateInstalls(env: NodeJS.ProcessEnv = process.env): LocateResult {
  const candidates: CandidateReport[] = [];
  const installs: InstallLayout[] = [];

  const override = env[ROOT_ENV_VAR]?.trim();
  if (override) {
    const status = isInstallRoot(override) ? 'env-override' : 'incomplete';
    candidates.push({ path: override, kind: 'desktop', status });
    if (status === 'env-override') {
      installs.push(buildLayout(override, detectKind(override)));
      return { installs, candidates, platform: platform() };
    }
    return {
      installs,
      candidates,
      platform: platform(),
      hint: `${ROOT_ENV_VAR} does not point at a Cursor installation (no product.json and out/): ${override}`,
    };
  }

  for (const path of desktopCandidates()) {
    if (!existsSync(path)) {
      candidates.push({ path, kind: 'desktop', status: 'missing' });
      continue;
    }
    if (!isInstallRoot(path)) {
      candidates.push({ path, kind: 'desktop', status: 'incomplete' });
      continue;
    }
    candidates.push({ path, kind: 'desktop', status: 'ok' });
    installs.push(buildLayout(path, 'desktop'));
  }

  for (const path of serverCandidates(env)) {
    if (!isInstallRoot(path)) {
      candidates.push({ path, kind: 'server', status: 'incomplete' });
      continue;
    }
    candidates.push({ path, kind: 'server', status: 'ok' });
    installs.push(buildLayout(path, 'server'));
  }

  const hint =
    installs.length === 0
      ? `No Cursor installation found. Set ${ROOT_ENV_VAR} to the directory containing product.json if Cursor lives somewhere unusual.`
      : undefined;

  return { installs, candidates, platform: platform(), ...(hint ? { hint } : {}) };
}

function detectKind(root: string): InstallKind {
  return root.includes('.cursor-server') ? 'server' : 'desktop';
}

/** Renders a locate result for a terminal, including every path tried. */
export function formatLocateResult(result: LocateResult): string {
  const lines = [`Platform: ${result.platform}`, 'Candidates:'];
  if (result.candidates.length === 0) lines.push('  (none — unsupported platform)');
  for (const candidate of result.candidates) {
    const mark =
      candidate.status === 'ok' || candidate.status === 'env-override'
        ? '+'
        : candidate.status === 'incomplete'
          ? '~'
          : '-';
    lines.push(`  ${mark} [${candidate.kind}] ${candidate.path}`);
  }
  if (result.hint) lines.push('', result.hint);
  return lines.join('\n');
}
