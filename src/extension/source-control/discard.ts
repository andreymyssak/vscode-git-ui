import { basename } from 'node:path';

import * as vscode from 'vscode';

import { dirtySelectedDocuments } from '../changes/prompts';
import type { SourceControlBackend } from '../git/source-control/index';
import type { SourceControlModel } from './model';
import { requireLiveRepository } from './writes';

/** VS Code owns restoration from the index and deletion/trash of untracked files. */
export async function discardWorking(options: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  id: string;
  path: string;
}): Promise<void> {
  const { runtime, model, id, path } = options;

  requireLiveRepository(runtime, model, id);
  const prepared = await runtime.prepareDiscard({ id, path });
  const current = prepared.file;
  const root = runtime.root(id);
  const requireSaved = () => {
    if (dirtySelectedDocuments(root, [current]).length)
      throw new Error(
        'This file has unsaved edits. Save or revert them before discarding its Git changes.',
      );
  };

  requireSaved();
  const name = basename(path);
  const restore = current.status[1] === 'D';
  const trash =
    current.untracked &&
    !vscode.env.remoteName &&
    vscode.workspace
      .getConfiguration('git')
      .get<boolean>('discardUntrackedChangesToTrash', true);
  const action = restore
    ? 'Restore File'
    : current.untracked
      ? trash
        ? process.platform === 'win32'
          ? 'Move to Recycle Bin'
          : 'Move to Trash'
        : 'Delete File'
      : 'Discard File';
  const message = restore
    ? `Are you sure you want to restore '${name}'?`
    : current.untracked
      ? `Are you sure you want to delete '${name}'?`
      : `Are you sure you want to discard changes in '${name}'?`;
  const answer = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    action,
  );

  if (answer !== action) return;
  await prepared.write({
    beforeWrite: () => {
      requireLiveRepository(runtime, model, id);
      requireSaved();
    },
  });
}
