/**
 * The slice of the VSCode extension API this extension uses.
 *
 * Declared locally rather than depending on `@types/vscode`: the extension
 * touches a dozen members, and a local declaration keeps the build offline and
 * makes the coupling to the host API explicit and auditable in one file.
 */

declare module 'vscode' {
  /** The host's promise-like return type; part of the public API surface. */
  export interface Thenable<T> extends PromiseLike<T> {}

  export interface Disposable {
    dispose(): void;
  }

  export interface OutputChannel extends Disposable {
    appendLine(value: string): void;
    show(preserveFocus?: boolean): void;
  }

  export interface StatusBarItem extends Disposable {
    text: string;
    tooltip?: string;
    command?: string;
    show(): void;
    hide(): void;
  }

  export interface ExtensionContext {
    subscriptions: Disposable[];
    extensionPath: string;
    extensionUri: Uri;
  }

  export interface Uri {
    readonly fsPath: string;
    toString(): string;
  }

  export namespace Uri {
    function joinPath(base: Uri, ...segments: string[]): Uri;
    function file(path: string): Uri;
  }

  export interface Event<T> {
    (listener: (event: T) => unknown): Disposable;
  }

  export interface Webview {
    html: string;
    options: { enableScripts?: boolean; localResourceRoots?: Uri[] };
    cspSource: string;
    asWebviewUri(resource: Uri): Uri;
    postMessage(message: unknown): Thenable<boolean>;
    onDidReceiveMessage: Event<unknown>;
  }

  export interface WebviewView {
    readonly webview: Webview;
    readonly visible: boolean;
    title?: string;
    description?: string;
    onDidDispose: Event<void>;
    onDidChangeVisibility: Event<void>;
    show(preserveFocus?: boolean): void;
  }

  export interface WebviewViewProvider {
    resolveWebviewView(view: WebviewView, context: unknown, token: unknown): void | Thenable<void>;
  }

  export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue: T): T;
  }

  export interface QuickPickItem {
    label: string;
    detail?: string;
  }

  export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
  }

  export namespace window {
    function createOutputChannel(name: string): OutputChannel;
    function createStatusBarItem(alignment: StatusBarAlignment, priority?: number): StatusBarItem;
    function registerWebviewViewProvider(
      viewId: string,
      provider: WebviewViewProvider,
      options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
    ): Disposable;
    function showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function showQuickPick(items: QuickPickItem[], options?: { title?: string }): Thenable<QuickPickItem | undefined>;
    function showTextDocument(document: TextDocument): Thenable<unknown>;
  }

  export interface TextDocument {
    readonly fileName: string;
  }

  export namespace workspace {
    function getConfiguration(section?: string): WorkspaceConfiguration;
    function openTextDocument(path: string): Thenable<TextDocument>;
  }

  export namespace commands {
    function registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
  }
}
