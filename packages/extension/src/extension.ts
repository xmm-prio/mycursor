/**
 * MyCursor extension: lifecycle and controls, nothing else.
 *
 * Installing this extension is optional, and it contains no interception logic
 * — that lives in the payload the installer prepends to Cursor's own bundles.
 * Keeping the two apart matters: the extension can be disabled, reloaded, or
 * uninstalled without changing how traffic is routed, and a bug here cannot
 * break routing.
 *
 * It also explains why this is a normal user extension rather than one dropped
 * among Cursor's built-ins: no signature verification has to be patched to
 * install it.
 */

import { join } from 'node:path';

import * as vscode from 'vscode';

import { loadConfigFrom, resolveConfigPaths, saveConfigTo } from '@mycursor/core/config';
import { STATUS_PATH, TOGGLE_PATH, type ServerStatusReport } from '@mycursor/server';

import { MyCursorPanel } from './panel/provider.js';
import { ServerSupervisor, type ServerState } from './server-process.js';

let supervisor: ServerSupervisor | null = null;
let statusItem: vscode.StatusBarItem | null = null;
let channel: vscode.OutputChannel | null = null;
let panel: MyCursorPanel | null = null;

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('MyCursor');
  context.subscriptions.push(channel);
  const log = (message: string): void => channel?.appendLine(`${new Date().toISOString()} ${message}`);

  const settings = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('mycursor');

  supervisor = new ServerSupervisor({
    config: () => loadConfigFrom(resolveConfigPaths().config).config,
    launcherPath: () => {
      const override = settings().get<string>('server.launcher', '');
      if (override) return override;
      // Resolved from the extension directory so a packaged VSIX works without
      // any assumption about where the repository lives.
      return join(context.extensionPath, 'dist', 'server', 'launch.js');
    },
    log,
  });
  context.subscriptions.push({ dispose: () => supervisor?.dispose() });

  // The sidebar panel is the primary surface; registering it before the
  // server starts means the user sees state — including "server offline" —
  // rather than an empty view while it comes up.
  panel = new MyCursorPanel(context.extensionUri, context.extensionPath, {
    log,
    restartServer: async () => {
      await supervisor?.restart();
      await refreshStatusBar();
    },
    ensureServer: async () => {
      await supervisor?.ensureRunning();
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MyCursorPanel.viewId, panel, {
      // The draft survives the panel being hidden, so a half-finished provider
      // is not lost by switching to the file explorer.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  if (settings().get<boolean>('statusBar.enabled', true)) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'mycursor.showStatus';
    context.subscriptions.push(statusItem);
    statusItem.show();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('mycursor.toggleByok', () => void toggleByok(log)),
    vscode.commands.registerCommand('mycursor.restartServer', () => void restartServer(log)),
    vscode.commands.registerCommand('mycursor.stopServer', () => {
      supervisor?.stop();
      void refreshStatusBar();
    }),
    vscode.commands.registerCommand('mycursor.showStatus', () => void showStatus()),
    vscode.commands.registerCommand('mycursor.openConfig', () => void openFile(resolveConfigPaths().config)),
    vscode.commands.registerCommand('mycursor.openProviders', () =>
      void openFile(resolveConfigPaths().providers),
    ),
  );

  if (settings().get<boolean>('server.autoStart', true)) {
    void supervisor.ensureRunning().then((state) => {
      if (state === 'failed') {
        void vscode.window.showWarningMessage(
          'MyCursor: the BYOK server did not start. Model requests will use Cursor\'s own API until it does.',
          'Show Log',
        ).then((choice) => {
          if (choice === 'Show Log') channel?.show(true);
        });
      }
      void refreshStatusBar();
    });
  } else {
    void refreshStatusBar();
  }

  // Polling is crude but honest: the server is a separate process that can be
  // stopped from a terminal, and the status bar should not claim otherwise.
  const timer = setInterval(() => void refreshStatusBar(), 10_000);
  timer.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
  supervisor?.dispose();
  supervisor = null;
  statusItem = null;
  channel = null;
  panel = null;
}

async function fetchStatus(): Promise<ServerStatusReport | null> {
  const { server } = loadConfigFrom(resolveConfigPaths().config).config;
  try {
    const response = await fetch(`http://${server.host}:${server.port}${STATUS_PATH}`);
    return (await response.json()) as ServerStatusReport;
  } catch {
    return null;
  }
}

async function refreshStatusBar(): Promise<void> {
  if (!statusItem) return;
  const report = await fetchStatus();
  const state: ServerState = supervisor?.currentState() ?? 'stopped';

  if (!report) {
    statusItem.text = '$(circle-slash) BYOK off';
    statusItem.tooltip = `MyCursor server is not answering (${state})`;
    return;
  }
  statusItem.text = report.byokMode ? '$(check) BYOK on' : '$(circle-outline) BYOK idle';
  statusItem.tooltip = [
    `MyCursor ${report.version}`,
    `byok mode: ${report.byokMode ? 'on' : 'off'}`,
    `models: ${report.models}`,
    `route rules: ${report.routeRules}`,
    `uptime: ${report.uptimeSeconds}s`,
  ].join('\n');
}

/**
 * Flips BYOK mode.
 *
 * The running server is asked first so the change reaches every patched
 * process through the same path a manual edit would. Only when no server is
 * reachable is the document written directly.
 */
async function toggleByok(log: (message: string) => void): Promise<void> {
  const paths = resolveConfigPaths();
  const { server } = loadConfigFrom(paths.config).config;
  try {
    const response = await fetch(`http://${server.host}:${server.port}${TOGGLE_PATH}`, {
      method: 'POST',
    });
    const body = (await response.json()) as { byokMode?: boolean };
    log(`BYOK mode toggled via the server to ${body.byokMode ? 'on' : 'off'}`);
    void vscode.window.showInformationMessage(`MyCursor: BYOK mode ${body.byokMode ? 'on' : 'off'}`);
  } catch {
    const loaded = loadConfigFrom(paths.config);
    const next = { ...loaded.config, byokMode: !loaded.config.byokMode };
    saveConfigTo(paths.config, next);
    log(`server unreachable; wrote byokMode=${next.byokMode} to ${paths.config}`);
    void vscode.window.showInformationMessage(
      `MyCursor: BYOK mode ${next.byokMode ? 'on' : 'off'} (written to disk; server was not running)`,
    );
  }
  await refreshStatusBar();
}

async function restartServer(log: (message: string) => void): Promise<void> {
  const state = await supervisor?.restart();
  log(`restart finished in state ${state}`);
  await refreshStatusBar();
}

async function showStatus(): Promise<void> {
  const report = await fetchStatus();
  if (!report) {
    const choice = await vscode.window.showWarningMessage(
      'MyCursor: the BYOK server is not answering.',
      'Start Server',
      'Show Log',
    );
    if (choice === 'Start Server') await supervisor?.ensureRunning();
    if (choice === 'Show Log') channel?.show(true);
    await refreshStatusBar();
    return;
  }

  const items: vscode.QuickPickItem[] = [
    { label: 'Open MyCursor panel', detail: 'configure providers and models' },
    { label: `BYOK mode: ${report.byokMode ? 'on' : 'off'}`, detail: 'select to toggle' },
    { label: `Models: ${report.models}`, detail: report.providers.map((p) => `${p.id} (${p.kind})`).join(', ') },
    { label: `Route rules: ${report.routeRules}` },
    {
      label: `Dispatch: ${Object.entries(report.counters).map(([k, v]) => `${k}=${v}`).join('  ') || 'none yet'}`,
    },
    { label: 'Open configuration' },
    { label: 'Open providers' },
    { label: 'Restart server' },
  ];
  if (report.warnings.length > 0) {
    items.push({ label: `Warnings: ${report.warnings.length}`, detail: report.warnings[0] });
  }

  const picked = await vscode.window.showQuickPick(items, { title: `MyCursor ${report.version}` });
  if (!picked) return;

  if (picked.label === 'Open MyCursor panel') {
    if (!panel?.reveal()) {
      void vscode.window.showInformationMessage(
        'MyCursor: open the MyCursor icon in the activity bar to show the panel.',
      );
    }
  } else if (picked.label.startsWith('BYOK mode')) await toggleByok((m) => channel?.appendLine(m));
  else if (picked.label === 'Open configuration') await openFile(resolveConfigPaths().config);
  else if (picked.label === 'Open providers') await openFile(resolveConfigPaths().providers);
  else if (picked.label === 'Restart server') await restartServer((m) => channel?.appendLine(m));
}

async function openFile(path: string): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(path);
    await vscode.window.showTextDocument(document);
  } catch (error) {
    void vscode.window.showErrorMessage(`MyCursor: cannot open ${path}: ${(error as Error).message}`);
  }
}
