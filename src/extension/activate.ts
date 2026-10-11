import * as vscode from 'vscode';

import {
  commandId,
  EMPTY_DOCUMENT_SCHEME,
  LOG_VIEW_ID,
  SNAPSHOT_DOCUMENT_SCHEME,
} from '../shared/extension-identity';
import { EmptyDocumentProvider } from './native/empty-document';
import { SnapshotDocumentProvider } from './native/snapshot-document';
import { registerSourceControlViews } from './native/source-control-views';
import { GitViewProvider } from './panel/provider';

export function activate(context: vscode.ExtensionContext): void {
  registerSourceControlViews(context);
  const provider = new GitViewProvider(
    context.extensionUri,
    context.globalStorageUri,
  );

  for (const kind of [
    'update-branch',
    'merge-branch',
    'rebase-branch',
    'create-worktree',
    'checkout',
    'create-branch',
    'rename-branch',
    'delete-branch',
    'delete-branches',
    'copy-branch',
  ] as const)
    context.subscriptions.push(
      vscode.commands.registerCommand(
        commandId(kind),
        async (value: unknown) => {
          try {
            await provider.executeBranchAction(kind, value);
          } catch (error) {
            await vscode.window.showErrorMessage(
              error instanceof Error ? error.message : String(error),
              'Dismiss',
            );
          }
        },
      ),
    );
  for (const kind of [
    'copy-sha',
    'cherry-pick',
    'edit-commit-message',
    'squash-commits',
    'branch-from-commit',
    'tag-from-commit',
    'drop-commits',
  ] as const)
    context.subscriptions.push(
      vscode.commands.registerCommand(
        commandId(kind),
        async (value: unknown) => {
          try {
            await provider.executeCommitAction(kind, value);
          } catch (error) {
            await vscode.window.showErrorMessage(
              error instanceof Error ? error.message : String(error),
              'Dismiss',
            );
          }
        },
      ),
    );
  for (const kind of [
    'open-worktree-new',
    'open-worktree-current',
    'delete-worktrees',
  ] as const)
    context.subscriptions.push(
      vscode.commands.registerCommand(
        commandId(kind),
        async (value: unknown) => {
          try {
            await provider.executeWorktreeAction(kind, value);
          } catch (error) {
            await vscode.window.showErrorMessage(
              error instanceof Error ? error.message : String(error),
              'Dismiss',
            );
          }
        },
      ),
    );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      EMPTY_DOCUMENT_SCHEME,
      new EmptyDocumentProvider(),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      SNAPSHOT_DOCUMENT_SCHEME,
      new SnapshotDocumentProvider(),
    ),
    vscode.window.registerWebviewViewProvider(LOG_VIEW_ID, provider),
  );
}
