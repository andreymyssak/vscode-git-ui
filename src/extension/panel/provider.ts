import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import {
  extensionIdentity,
  LOG_VIEW_ID,
} from '../../shared/extension-identity';
import type {
  BranchActionKind,
  CommitActionKind,
  WorktreeActionKind,
} from '../../shared/messages';
import type { GitAdapter } from '../git/adapter';
import { createGitAdapter } from '../git/adapter';
import { getGitApi } from '../git/api';
import {
  askWorktree,
  confirmBranchIntegration,
  pickWorktreeBranch,
} from '../native/branch-integration';
import {
  askBranchName,
  askCommitMessage,
  askRenameBranch,
  askSquashMessage,
  askTagName,
  confirmDrop,
} from '../native/dialogs';
import { openChange } from '../native/editors';
import {
  showBranchDeleted,
  showOperationError,
  showOperationInfo,
} from '../native/operation-feedback';
import { openWorktree } from '../native/worktrees';
import { type CommitJump, CommitJumpQueue } from './commit-jump';
import { PanelController } from './controller';
import { attachFileIcons } from './file-icon-host';
import {
  branchMenuRequest,
  commitMenuRequest,
  parseRequest,
  worktreeMenuRequest,
} from './protocol';

export class GitViewProvider implements vscode.WebviewViewProvider {
  private readonly jumps = new CommitJumpQueue();
  private focusSequence = 0;
  private viewCleanup: (() => void) | null = null;

  async revealCommit(target: CommitJump): Promise<void> {
    const sequence = ++this.focusSequence;
    const pending = this.jumps.enqueue(target);

    void pending.catch(() => {});
    try {
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
    } catch (error) {
      if (sequence !== this.focusSequence) return;
      this.jumps.detach(error);
    }

    await pending;
  }

  dispose(): void {
    this.jumps.dispose();
    this.viewCleanup?.();
  }

  private menuAction:
    ((kind: BranchActionKind, value: unknown) => Promise<void>) | null = null;

  private commitMenuAction:
    ((kind: CommitActionKind, value: unknown) => Promise<void>) | null = null;

  private worktreeMenuAction:
    ((kind: WorktreeActionKind, value: unknown) => Promise<void>) | null = null;

  async executeWorktreeAction(
    kind: WorktreeActionKind,
    value: unknown,
  ): Promise<void> {
    if (!this.worktreeMenuAction)
      throw new Error('Open Worktrees and select a worktree first.');
    await this.worktreeMenuAction(kind, value);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStorageUri: vscode.Uri,
  ) {}

  async executeBranchAction(
    kind: BranchActionKind,
    value: unknown,
  ): Promise<void> {
    if (!this.menuAction)
      throw new Error(
        `Open ${extensionIdentity.displayName} and select a branch first.`,
      );
    await this.menuAction(kind, value);
  }

  async executeCommitAction(
    kind: CommitActionKind,
    value: unknown,
  ): Promise<void> {
    if (!this.commitMenuAction)
      throw new Error(
        `Open ${extensionIdentity.displayName} and select a commit first.`,
      );
    await this.commitMenuAction(kind, value);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const webview = view.webview;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');

    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const script = webview
      .asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'))
      .toString();
    const style = webview
      .asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'))
      .toString();
    const nonce = randomBytes(16).toString('hex');
    const fileIcons = attachFileIcons(webview, this.globalStorageUri, dist);

    webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><main id="app" aria-live="polite">Connecting to Git…</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    let controller: PanelController | null = null;
    let initializing: Promise<PanelController> | null = null;
    let closed = false;
    let initializationEpoch = 0;
    const initialize = async (): Promise<PanelController> => {
      const epoch = ++initializationEpoch;
      let setupError: string | null = null;
      let adapter: GitAdapter | null = null;
      let initialRepositoryId: string | null = null;

      if (vscode.workspace.isTrusted) {
        try {
          adapter = await createGitAdapter(undefined, {
            runtime: {
              executable: process.execPath,
              helperPath: vscode.Uri.joinPath(
                this.extensionUri,
                'dist',
                'squash-helper.cjs',
              ).fsPath,
            },
            storageDirectory: vscode.Uri.joinPath(
              this.globalStorageUri,
              'squash-recovery',
            ).fsPath,
          });
          const active = vscode.window.activeTextEditor?.document.uri;

          if (active)
            initialRepositoryId =
              (await getGitApi()).api
                .getRepository(active)
                ?.rootUri.toString() ?? null;
        } catch (error) {
          setupError = error instanceof Error ? error.message : String(error);
          adapter?.dispose();
          adapter = null;
        }
      }

      const result = new PanelController({
        adapter,
        trusted: () => vscode.workspace.isTrusted,
        askBranchName,
        askTagName,
        confirmDrop,
        askRenameBranch,
        confirmBranchIntegration,
        askWorktree,
        pickWorktreeBranch,
        askCommitMessage,
        askSquashMessage,
        reportBranchDeleted: showBranchDeleted,
        reportActionError: showOperationError,
        reportActionInfo: showOperationInfo,
        openWorktree,
        confirmWorktreeDeletion: async (items) =>
          (await vscode.window.showWarningMessage(
            items.length === 1
              ? `Delete worktree "${items[0]!.name}" and its folder?`
              : `Delete ${items.length} worktrees and their folders?`,
            'Delete',
          )) === 'Delete',
        copyText: async (text) => {
          await vscode.env.clipboard.writeText(text);
        },
        nativeAction: async (action) => {
          await vscode.commands.executeCommand(
            action === 'trust'
              ? 'workbench.trust.manage'
              : 'workbench.view.scm',
          );
        },
        send: async (message) => {
          if (!closed) await webview.postMessage(message);
        },
        openChange: async (id, handle, preview, current) =>
          openChange(await getGitApi(), id, handle, preview, current),
        pickRepository: async () => {
          const repositories = adapter?.repositories() ?? [];
          const choice = await vscode.window.showQuickPick(
            repositories.map((repository) => ({
              label: repository.label,
              description: vscode.Uri.parse(repository.rootUri).fsPath,
              id: repository.id,
            })),
            { placeHolder: 'Select repository' },
          );

          return choice?.id ?? null;
        },
        pickAuthors: async (authors, selected, signal) => {
          const cancellation = new vscode.CancellationTokenSource();
          const abort = () => cancellation.cancel();

          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) cancellation.cancel();
          try {
            const choices = await vscode.window.showQuickPick(
              authors.map((identity) => ({
                label: identity.name || identity.email,
                detail:
                  identity.name && identity.name !== identity.email
                    ? identity.email
                    : '',
                identity,
                picked: selected.some(
                  (author) =>
                    author.name === identity.name &&
                    author.email === identity.email,
                ),
              })),
              {
                title: 'Select commit authors',
                placeHolder: 'Search name or email',
                canPickMany: true,
                matchOnDetail: true,
              },
              cancellation.token,
            );

            return choices?.map((choice) => choice.identity) ?? null;
          } finally {
            signal.removeEventListener('abort', abort);
            cancellation.dispose();
          }
        },
        pickReference: async (references) =>
          (
            await vscode.window.showQuickPick(
              references.map((ref) => ({
                label: ref.name,
                description: ref.kind,
                id: ref.id,
              })),
              { placeHolder: 'Choose branch or tag' },
            )
          )?.id ?? null,
        offerNavigation: async (decision) => {
          const action =
            decision.kind === 'offer-clear'
              ? 'Clear Filters and Go To'
              : 'Show Commit History';

          return (
            (await vscode.window.showInformationMessage(
              decision.kind === 'offer-clear'
                ? 'The commit is outside the current results.'
                : 'The commit is outside All branches.',
              { modal: true },
              action,
            )) === action
          );
        },
        navigationProgress: async (work) => {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Finding commit',
              cancellable: true,
            },
            async (progress, token) => {
              const abort = new AbortController();
              const cancellation = token.onCancellationRequested(() =>
                abort.abort(),
              );

              try {
                await work(abort.signal, (count) =>
                  progress.report({ message: `${count} commits checked` }),
                );
              } catch (error) {
                if (!abort.signal.aborted) throw error;
              } finally {
                cancellation.dispose();
              }
            },
          );
        },
        initialRepositoryId,
        setupError,
      });

      if (closed || epoch !== initializationEpoch) result.dispose();
      else controller = result;

      return result;
    };

    const menuAction = async (kind: BranchActionKind, value: unknown) => {
      const request = branchMenuRequest(kind, value);

      if (!request)
        throw new Error(
          `Select a branch in ${extensionIdentity.displayName} before using this action.`,
        );
      initializing ??= initialize();
      await (await initializing).handle(request);
    };

    this.menuAction = menuAction;
    const commitMenuAction = async (kind: CommitActionKind, value: unknown) => {
      const request = commitMenuRequest(kind, value);

      if (!request)
        throw new Error(
          `Select a commit in ${extensionIdentity.displayName} before using this action.`,
        );
      initializing ??= initialize();
      await (await initializing).handle(request);
    };

    this.commitMenuAction = commitMenuAction;
    const worktreeMenuAction = async (
      kind: WorktreeActionKind,
      value: unknown,
    ) => {
      const request = worktreeMenuRequest(kind, value);

      if (!request) throw new Error('Select worktrees from the current list.');
      initializing ??= initialize();
      await (await initializing).handle(request);
    };

    this.worktreeMenuAction = worktreeMenuAction;
    const handleMessage = async (result: PanelController, message: unknown) => {
      await result.handle(message);
      if (
        !closed &&
        controller === result &&
        parseRequest(message)?.body.kind === 'ready'
      )
        this.jumps.attach((target) => result.revealCommit(target));
    };

    const messages = webview.onDidReceiveMessage((message: unknown) => {
      if (parseRequest(message)?.body.kind === 'ready') fileIcons.ready();
      initializing ??= initialize();
      void initializing
        .then((result) => handleMessage(result, message))
        .catch((error) => {
          this.jumps.detach(error);
          vscode.window.showErrorMessage(
            error instanceof Error
              ? error.message
              : `${extensionIdentity.displayName} initialization failed.`,
            'Dismiss',
          );
        });
    });
    const trust = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      this.jumps.detach();
      controller?.dispose();
      controller = null;
      initializing = initialize();
      void initializing
        .then((result) =>
          handleMessage(result, {
            requestId: 'trust',
            repositoryId: '',
            generation: 0,
            body: { kind: 'ready', savedRepositoryId: null },
          }),
        )
        .catch((error) =>
          vscode.window.showErrorMessage(String(error), 'Dismiss'),
        );
    });
    const settings = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('git.enabled')) {
        this.jumps.detach();
        controller?.dispose();
        controller = null;
        initializing = initialize();
        void initializing
          .then((result) =>
            handleMessage(result, {
              requestId: 'settings',
              repositoryId: '',
              generation: 0,
              body: { kind: 'ready', savedRepositoryId: null },
            }),
          )
          .catch((error) =>
            vscode.window.showErrorMessage(String(error), 'Dismiss'),
          );
      }
    });
    const visibility = view.onDidChangeVisibility(() => {
      // Hidden views can lose their frontend while retaining this controller.
      // Wait for the recreated frontend's ready message before another jump.
      if (!view.visible) this.jumps.detach();
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (this.viewCleanup === cleanup) {
        this.jumps.detach();
        this.viewCleanup = null;
      }

      if (this.menuAction === menuAction) this.menuAction = null;
      if (this.commitMenuAction === commitMenuAction)
        this.commitMenuAction = null;
      if (this.worktreeMenuAction === worktreeMenuAction)
        this.worktreeMenuAction = null;
      controller?.dispose();
      fileIcons.dispose();
      messages.dispose();
      trust.dispose();
      settings.dispose();
      visibility.dispose();
      viewDisposed?.dispose();
    };

    this.viewCleanup = cleanup;
    const viewDisposed = view.onDidDispose(cleanup);
  }
}
