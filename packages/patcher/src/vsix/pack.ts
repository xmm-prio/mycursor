/**
 * Packaging the extension as a VSIX and installing it into Cursor.
 *
 * Doing this from the toolkit's own CLI is what makes a single `npx` command
 * enough: patch the installation, recover the schema, install the panel. The
 * alternative — telling the user to build a VSIX with a separate tool and
 * install it by hand — is three more steps at exactly the point where nothing
 * visibly works yet.
 *
 * The extension is installed the supported way, through Cursor's own CLI, so
 * it lands in the user extensions directory and is subject to the same
 * lifecycle as any other extension. It is *not* dropped among Cursor's
 * built-ins, which would require defeating signature verification.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { createZip, type ZipEntry } from './zip.js';

export interface ExtensionManifest {
  name: string;
  publisher: string;
  version: string;
  displayName?: string;
  description?: string;
  icon?: string;
  engines?: { vscode?: string };
  /**
   * Packaging overrides.
   *
   * The workspace package is named `@mycursor/extension`, but a VSCode
   * extension identifier may not be scoped, and only a few of the built files
   * belong in the package. Both are stated explicitly rather than derived, so
   * what ships is visible in the manifest instead of implied by the packer.
   */
  vsix?: {
    name?: string;
    publisher?: string;
    /** Paths to include, relative to the extension root. `**` matches a subtree. */
    include?: string[];
  };
}

export interface PackResult {
  vsixPath: string;
  entries: number;
  bytes: number;
  identifier: string;
}

/** Directories and files never worth shipping, used when no include list exists. */
const EXCLUDED_NAMES = new Set(['node_modules', '.git', '.vscode', 'src', 'types', 'build.mjs']);

/** Build by-products that would otherwise bloat the package. */
const EXCLUDED_SUFFIXES = ['.d.ts', '.d.ts.map', '.js.map', '.tsbuildinfo', 'tsconfig.json'];

function collect(root: string, current = root, found: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    if (EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) collect(root, path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * Resolves an explicit include list.
 *
 * Only the two patterns the manifests need are supported: an exact path, and
 * a `dir/**` subtree. A glob library would be a dependency for two cases.
 */
function collectIncluded(root: string, patterns: readonly string[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/**')) {
      const directory = join(root, pattern.slice(0, -3));
      if (existsSync(directory)) found.push(...collect(root, directory));
      continue;
    }
    const path = join(root, pattern);
    if (existsSync(path) && statSync(path).isFile()) found.push(path);
  }
  return [...new Set(found)];
}

/**
 * `[Content_Types].xml` maps file extensions to MIME types.
 *
 * The installer rejects a package whose extensions are not all declared, so
 * the map is derived from what is actually being shipped rather than fixed.
 */
function contentTypes(paths: readonly string[]): string {
  const known: Record<string, string> = {
    json: 'application/json',
    js: 'application/javascript',
    cjs: 'application/javascript',
    css: 'text/css',
    html: 'text/html',
    md: 'text/markdown',
    png: 'image/png',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    map: 'application/json',
    vsixmanifest: 'text/xml',
  };

  const extensions = new Set<string>(['vsixmanifest']);
  for (const path of paths) {
    const extension = path.split('.').pop();
    if (extension) extensions.add(extension.toLowerCase());
  }

  const defaults = [...extensions]
    .map((extension) => `  <Default Extension="${extension}" ContentType="${known[extension] ?? 'application/octet-stream'}"/>`)
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n${defaults}\n</Types>\n`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function vsixManifest(manifest: ExtensionManifest, name: string, publisher: string): string {
  const engine = manifest.engines?.vscode ?? '^1.90.0';
  const icon = manifest.icon
    ? `\n    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${manifest.icon}" Addressable="true"/>`
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(name)}" Version="${escapeXml(manifest.version)}" Publisher="${escapeXml(publisher)}"/>
    <DisplayName>${escapeXml(manifest.displayName ?? name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(manifest.description ?? '')}</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(engine)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>${icon}
  </Assets>
</PackageManifest>
`;
}

/** Builds a VSIX from a directory containing a built extension. */
export function packExtension(extensionRoot: string, outputPath: string): PackResult {
  const manifestPath = join(extensionRoot, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`no package.json in ${extensionRoot}; build the extension first`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ExtensionManifest;
  if (!manifest.name || !manifest.publisher || !manifest.version) {
    throw new Error('extension package.json needs name, publisher and version');
  }

  // A VSCode extension identifier cannot be scoped, so the workspace package
  // name is overridden by the `vsix` block when one is present.
  const name = manifest.vsix?.name ?? manifest.name.replace(/^@[^/]+\//, '');
  const publisher = manifest.vsix?.publisher ?? manifest.publisher;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`"${name}" is not a valid extension name; set vsix.name in package.json`);
  }

  const files = manifest.vsix?.include
    ? collectIncluded(extensionRoot, manifest.vsix.include)
    : collect(extensionRoot);
  if (!files.some((file) => file.endsWith(`${sep}package.json`))) {
    throw new Error('extension package.json was excluded from the package');
  }

  // The manifest inside the package carries the unscoped name, so Cursor and
  // the archive agree on the identifier.
  const shipped = JSON.stringify({ ...manifest, name, publisher }, null, 2);

  const relativePaths = files.map((file) => relative(extensionRoot, file).split(sep).join('/'));
  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: Buffer.from(contentTypes(relativePaths), 'utf-8') },
    { path: 'extension.vsixmanifest', data: Buffer.from(vsixManifest(manifest, name, publisher), 'utf-8') },
    ...files.map((file, index) => ({
      path: `extension/${relativePaths[index]!}`,
      data:
        relativePaths[index] === 'package.json' ? Buffer.from(shipped, 'utf-8') : readFileSync(file),
    })),
  ];

  const archive = createZip(entries);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, archive);

  return { vsixPath: outputPath, entries: entries.length, bytes: archive.length, identifier: `${publisher}.${name}` };
}

/**
 * Locates Cursor's command line launcher.
 *
 * It ships beside the application rather than on `PATH` for most installs, so
 * the well-known locations are tried before giving up and hoping `cursor`
 * resolves.
 */
export function findCursorCli(appRoot?: string): string | null {
  const candidates: string[] = [];

  if (appRoot) {
    // `resources/app` -> the launcher lives two levels up on every platform.
    const installRoot = join(appRoot, '..', '..');
    candidates.push(
      join(installRoot, 'bin', platform() === 'win32' ? 'cursor.cmd' : 'cursor'),
      join(installRoot, 'Contents', 'Resources', 'app', 'bin', 'cursor'),
      join(appRoot, 'bin', platform() === 'win32' ? 'cursor.cmd' : 'cursor'),
    );
  }

  const home = homedir();
  if (platform() === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    candidates.push(join(localAppData, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'));
  } else if (platform() === 'darwin') {
    candidates.push('/Applications/Cursor.app/Contents/Resources/app/bin/cursor');
    candidates.push(join(home, 'Applications/Cursor.app/Contents/Resources/app/bin/cursor'));
  } else {
    candidates.push('/usr/share/cursor/bin/cursor', '/opt/Cursor/bin/cursor', '/usr/bin/cursor');
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export interface InstallExtensionResult {
  ok: boolean;
  cli: string;
  output: string;
}

/**
 * Installs a VSIX through Cursor's CLI.
 *
 * `--force` is passed so re-running the installer upgrades in place instead of
 * failing on an already-installed identifier.
 */
export function installVsix(vsixPath: string, cliPath: string): InstallExtensionResult {
  const result = spawnSync(cliPath, ['--install-extension', vsixPath, '--force'], {
    encoding: 'utf-8',
    // The launcher is a shell script on Unix and a .cmd on Windows.
    shell: platform() === 'win32',
    windowsHide: true,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, cli: cliPath, output };
}

export function uninstallExtension(identifier: string, cliPath: string): InstallExtensionResult {
  const result = spawnSync(cliPath, ['--uninstall-extension', identifier], {
    encoding: 'utf-8',
    shell: platform() === 'win32',
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, cli: cliPath, output };
}
