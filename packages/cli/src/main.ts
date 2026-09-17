#!/usr/bin/env node
/**
 * `mycursor` command line.
 *
 * Argument parsing is hand-rolled rather than delegated to a library: the whole
 * surface is six verbs and three flags, and a dependency-free CLI is one fewer
 * thing that can break an installer people run with `npx`.
 */

import { loadConfigFrom, resolveConfigPaths } from '@mycursor/core/config';
import { MyCursorServer } from '@mycursor/server';
import { createExampleProviders, loadProvidersFrom, saveProvidersTo } from '@mycursor/providers';

import { extension } from './commands/extension.js';
import { install } from './commands/install.js';
import { schema } from './commands/schema.js';
import { status } from './commands/status.js';
import { uninstall } from './commands/uninstall.js';
import { bold, detail, dim, heading, info, ok, rows, warn } from './ui.js';

const USAGE = `
${bold('mycursor')} — bring your own key to Cursor

${bold('Usage')}
  mycursor <command> [options]

${bold('Commands')}
  install            patch Cursor, recover its schema and install the panel
  uninstall          restore every patched file
  extension          package and install the MyCursor panel on its own
  schema             recover Cursor's protobuf schema from the installation
  status             show configuration, providers, schema and patch state
  doctor             status plus per-target detail and route table diagnostics
  serve              run the BYOK server in the foreground
  providers          show the provider document, or create it with --init
  config             print the resolved configuration

${bold('Options')}
  --force            re-apply the payload even where it is already current
  --dry-run          report what install would do, write nothing
  --skip-extension   install: patch and extract, but leave the panel alone
  --pack-only        extension: build the VSIX without installing it
  --remove           extension: uninstall the panel
  --init             providers: write a template document
  --json             config: print raw JSON
  -h, --help         show this help

${bold('Environment')}
  MYCURSOR_HOME         override the configuration directory
  MYCURSOR_CURSOR_ROOT  point the locator at one specific installation
  MYCURSOR_LOG_LEVEL    debug | info | warn | error
`;

async function serve(): Promise<number> {
  heading('mycursor serve');
  const server = new MyCursorServer({
    ...(process.env['MYCURSOR_LOG_LEVEL']
      ? { logLevel: process.env['MYCURSOR_LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error' }
      : {}),
  });

  const running = await server.listen();
  ok(`plaintext  http://127.0.0.1:${running.plainPort}  (HTTP/1.1 + h2c)`);
  ok(`tls        https://127.0.0.1:${running.tlsPort}  (ALPN h2, http/1.1)`);
  const report = running.status();
  if (report.models === 0) {
    warn('no models are configured; edit providers.json and the change is picked up live');
  } else {
    info(`${report.models} model(s) from ${report.providers.length} provider(s)`);
  }
  console.log(dim('\n  press Ctrl+C to stop\n'));

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

function providers(init: boolean): number {
  const paths = resolveConfigPaths();
  if (init) {
    saveProvidersTo(paths.providers, createExampleProviders());
    ok(`wrote provider template to ${paths.providers}`);
    detail('set an apiKey and flip "enabled" to true');
    return 0;
  }

  heading('providers');
  const registry = loadProvidersFrom(paths.providers);
  info(paths.providers);
  if (registry.size === 0) {
    warn('no usable provider configured');
    for (const warning of registry.warnings) detail(warning);
    detail('run "mycursor providers --init" to create a template');
    return 0;
  }
  for (const provider of registry.list()) {
    rows([[`${provider.id} (${provider.kind})`, provider.models.map((model) => model.id).join(', ')]]);
  }
  for (const warning of registry.warnings) warn(warning);
  return 0;
}

function config(asJson: boolean): number {
  const paths = resolveConfigPaths();
  const loaded = loadConfigFrom(paths.config);
  if (asJson) {
    console.log(JSON.stringify(loaded.config, null, 2));
    return 0;
  }
  heading('configuration');
  info(`${paths.config} (${loaded.status})`);
  console.log(JSON.stringify(loaded.config, null, 2));
  for (const warning of loaded.warnings) warn(warning);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv.find((arg) => !arg.startsWith('-')) ?? '';
  const flags = new Set(argv.filter((arg) => arg.startsWith('-')));

  if (flags.has('-h') || flags.has('--help') || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'install':
      return install({
        force: flags.has('--force'),
        dryRun: flags.has('--dry-run'),
        skipExtension: flags.has('--skip-extension'),
      });
    case 'uninstall':
      return uninstall();
    case 'extension':
      return extension({ packOnly: flags.has('--pack-only'), remove: flags.has('--remove') });
    case 'schema':
      return schema({ dryRun: flags.has('--dry-run'), force: flags.has('--force') });
    case 'status':
      return status(false);
    case 'doctor':
      return status(true);
    case 'serve':
      return serve();
    case 'providers':
      return providers(flags.has('--init'));
    case 'config':
      return config(flags.has('--json'));
    default:
      console.log(`unknown command: ${command}`);
      console.log(USAGE);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`\nmycursor failed: ${error.message}`);
    if (process.env['MYCURSOR_LOG_LEVEL'] === 'debug') console.error(error.stack);
    process.exit(1);
  },
);
