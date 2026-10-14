import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import type { SourceControlActionKind } from '../../shared/extension-identity';
import {
  CHANGES_VIEW_ID,
  sourceControlCommandId,
} from '../../shared/extension-identity';
import type {
  SourceControlRequest,
  SourceControlState,
} from '../../shared/source-control';
import { parseSourceControlRequest } from '../../shared/source-control-protocol';
import { isRecord } from '../../shared/validation';
import { attachFileIcons } from '../panel/file-icon-host';
import { SourceControlService } from '../source-control/service';
import { showOperationError } from './operation-feedback';

const actions = [
  'refresh-changes',
  'check-all',
  'uncheck-all',
  'commit-checked',
  'rollback-selected',
  'commit-selected',
  'stash-selected',
  'copy-relative-path',
  'stash-checked',
  'show-changes',
  'discard-working-change',
  'resolve-conflicts',
  'accept-current',
  'accept-incoming',
  'stage-files',
  'unstage-files',
  'delete-files',
  'reveal-in-explorer',
  'reveal-in-os.mac',
  'reveal-in-os.windows',
  'reveal-in-os.linux',
  'open-stash-change',
  'apply-stash',
  'apply-stash-files',
  'delete-stash',
  'rename-stash',
  'delete-stash-files',
] satisfies SourceControlActionKind[];

function resourceUri(value: unknown): vscode.Uri | null {
  if (value instanceof vscode.Uri)
    return value.scheme === 'file' ? value : null;
  if (
    !isRecord(value) ||
    value.scheme !== 'file' ||
    typeof value.path !== 'string' ||
    !value.path.startsWith('/')
  )
    return null;

  return vscode.Uri.from({
    scheme: 'file',
    path: value.path,
    authority: typeof value.authority === 'string' ? value.authority : '',
    query: typeof value.query === 'string' ? value.query : '',
    fragment: typeof value.fragment === 'string' ? value.fragment : '',
  });
}

export class SourceControlViews
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private readonly service: SourceControlService;
  private readonly subscriptions: vscode.Disposable[] = [];
  private viewSubscriptions: vscode.Disposable[] = [];
  private view: vscode.WebviewView | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.service = new SourceControlService(context.workspaceState, (state) =>
      this.publish(state),
    );
    this.subscriptions.push(
      this.service,
      vscode.window.registerWebviewViewProvider(CHANGES_VIEW_ID, this),
    );
    for (const kind of actions)
      this.subscriptions.push(
        vscode.commands.registerCommand(
          sourceControlCommandId(kind),
          async (...args: unknown[]) => {
            try {
              if (kind === 'show-changes') await this.showChanges(args);
              else {
                const request = this.commandRequest(kind, args[0]);

                if (request) await this.service.handle(request, true);
              }
            } catch (error) {
              await showOperationError(
                error instanceof Error ? error.message : String(error),
                true,
              );
            }
          },
        ),
      );
  }

  dispose(): void {
    this.disposeView();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    this.view = view;
    const webview = view.webview;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');

    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const script = webview
      .asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'))
      .toString();
    const style = webview
      .asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'))
      .toString();
    const nonce = randomBytes(16).toString('hex');
    const fileIcons = attachFileIcons(
      webview,
      this.context.globalStorageUri,
      dist,
    );

    webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body data-view="source-control"><main id="app"><p role="status">Connecting to Git…</p></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.viewSubscriptions.push(
      fileIcons,
      webview.onDidReceiveMessage((value: unknown) => {
        const request = parseSourceControlRequest(value);

        if (!request) return;
        if (request.kind === 'ready') void fileIcons.ready();
        void this.service.handle(request);
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.service.refresh();
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = null;
          this.disposeView();
          void this.service.handle({ kind: 'cancel-generation' });
        }
      }),
    );
  }

  private disposeView(): void {
    this.view = null;
    const subscriptions = this.viewSubscriptions;

    this.viewSubscriptions = [];
    for (const subscription of subscriptions) subscription.dispose();
  }

  private publish(state: SourceControlState): void {
    if (this.view)
      void Promise.resolve(
        this.view.webview.postMessage({ kind: 'source-control-state', state }),
      ).catch(() => undefined);
  }

  private commandRequest(
    kind: Exclude<SourceControlActionKind, 'show-changes'>,
    argument: unknown,
  ): SourceControlRequest | null {
    if (kind === 'refresh-changes') return { kind: 'refresh' };
    const context = isRecord(argument) ? argument : {};
    const repositoryId =
      typeof context.repositoryId === 'string'
        ? context.repositoryId
        : this.service.model.repositoryId;

    if (!repositoryId)
      throw new Error('Choose a repository in Git UI before continuing.');
    switch (kind) {
      case 'check-all':
      case 'uncheck-all': {
        const repo = this.service.model.requireRepository(repositoryId);
        const paths =
          context.paths ??
          (repo.changes.kind === 'ready'
            ? repo.changes.items
                .filter(
                  (file) =>
                    typeof context.path !== 'string' ||
                    file.path === context.path ||
                    file.path.startsWith(`${context.path}/`),
                )
                .map((file) => file.path)
            : []);

        return parseSourceControlRequest({
          kind: 'check',
          repositoryId,
          paths,
          checked: kind === 'check-all',
        });
      }

      case 'commit-checked':
      case 'stash-checked':
        return parseSourceControlRequest({
          kind: kind === 'commit-checked' ? 'commit' : 'stash',
          repositoryId,
        });
      case 'rollback-selected':
      case 'commit-selected':
      case 'stash-selected':
      case 'copy-relative-path':
        return parseSourceControlRequest({
          kind:
            kind === 'copy-relative-path'
              ? 'copy-paths'
              : kind === 'rollback-selected'
                ? 'rollback'
                : kind,
          repositoryId,
          paths:
            kind === 'copy-relative-path'
              ? (context.copyPaths ?? context.paths ?? [context.path])
              : context.paths,
        });
      case 'delete-files':
      case 'resolve-conflicts':
      case 'accept-current':
      case 'accept-incoming':
      case 'stage-files':
      case 'unstage-files':
        return parseSourceControlRequest({
          kind,
          repositoryId,
          paths: context.paths,
        });
      case 'reveal-in-explorer':
      case 'reveal-in-os.mac':
      case 'reveal-in-os.windows':
      case 'reveal-in-os.linux':
        return parseSourceControlRequest({
          kind: kind === 'reveal-in-explorer' ? kind : 'reveal-in-os',
          repositoryId,
          path: context.path,
          paths: context.paths,
        });
      case 'discard-working-change':
        return parseSourceControlRequest({
          kind: 'discard-working',
          repositoryId,
          path: context.path,
        });
      case 'open-stash-change':
        return parseSourceControlRequest({
          kind: 'open-stash-files',
          repositoryId,
          sha: context.sha,
          files: context.files ?? [context.file],
        });
      case 'apply-stash':
      case 'delete-stash':
      case 'rename-stash':
        return parseSourceControlRequest({
          kind: kind === 'apply-stash' ? 'restore-stash' : kind,
          repositoryId,
          sha: context.sha,
        });
      case 'apply-stash-files':
      case 'delete-stash-files':
        return parseSourceControlRequest({
          kind: kind === 'apply-stash-files' ? 'restore-stash-files' : kind,
          repositoryId,
          sha: context.sha,
          files: context.files,
        });
    }
  }

  private async showChanges(args: unknown[]): Promise<void> {
    if (this.service.model.busy) return;
    await this.service.refresh();
    if (this.service.model.busy) return;
    const uris: vscode.Uri[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) collect(entry);
      } else {
        const uri = resourceUri(
          isRecord(value) && 'resourceUri' in value ? value.resourceUri : value,
        );

        if (uri) uris.push(uri);
      }
    };

    for (const arg of args) collect(arg);
    const selected = new Set(uris.map((uri) => uri.toString()));
    let firstRepositoryId: string | null = null;

    for (const repo of this.service.model.repositories.values()) {
      if (repo.changes.kind !== 'ready') continue;
      const paths = repo.changes.items
        .filter((file) =>
          selected.has(
            vscode.Uri.joinPath(
              vscode.Uri.parse(repo.info.rootUri),
              ...file.path.split('/'),
            ).toString(),
          ),
        )
        .map((file) => file.path);

      if (paths.length) {
        firstRepositoryId ??= repo.info.id;
        await this.service.handle({
          kind: 'check',
          repositoryId: repo.info.id,
          paths,
          checked: true,
        });
      }
    }

    if (firstRepositoryId)
      await this.service.handle({
        kind: 'repository',
        repositoryId: firstRepositoryId,
      });
    await this.service.handle({ kind: 'tab', tab: 'commit' });
    await vscode.commands.executeCommand(`${CHANGES_VIEW_ID}.focus`);
  }
}

export function registerSourceControlViews(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(new SourceControlViews(context));
}
