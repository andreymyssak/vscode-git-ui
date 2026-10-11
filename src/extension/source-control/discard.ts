import { basename } from 'node:path';

import * as vscode from 'vscode';

import { dirtySelectedDocuments } from '../changes/prompts';
import { withRepositoryOperation } from '../git/repository-operations';
import { readWorkingChanges } from '../git/working-changes';
import type { SourceControlModel } from './model';
import { requireLiveRepository, type SourceControlRuntime } from './writes';

/** VS Code owns restoration from the index and deletion/trash of untracked files. */
export async function discardWorking(options: {
  runtime: SourceControlRuntime;
  model: SourceControlModel;
  id: string;
  path: string;
}): Promise<void> {
  const { runtime, model, id, path } = options;

  requireLiveRepository(runtime, model, id);
  const repository = runtime.access.repository(id);
  let closed = false;
  const subscription = runtime.access.api.onDidCloseRepository((closing) => {
    if (closing.rootUri.toString() === id) closed = true;
  });
  const requireCurrent = () => {
    requireLiveRepository(runtime, model, id);
    if (closed)
      throw new Error(
        'The repository changed. Refresh and review the file again.',
      );

    return runtime.access.repository(id);
  };

  try {
    const current = (await readWorkingChanges(runtime.cli, id)).find(
      (file) => file.path === path,
    );

    if (!current?.working || /U|AA|DD/.test(current.status))
      throw new Error(
        'This file has no discardable working changes. Refresh and review it again.',
      );
    const root = repository.rootUri;
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
    await withRepositoryOperation(runtime.cli, id, async () => {
      const live = requireCurrent();
      const fresh = (await readWorkingChanges(runtime.cli, id)).find(
        (file) => file.path === path,
      );

      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(current))
        throw new Error(
          'This file changed while confirming. Refresh and review it again.',
        );
      requireSaved();
      await live.status();
      requireCurrent();
      await live.clean([vscode.Uri.joinPath(root, ...path.split('/')).fsPath]);
    });
  } finally {
    subscription.dispose();
  }
}
