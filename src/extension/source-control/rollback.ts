import * as vscode from 'vscode';

import { dirtySelectedDocuments } from '../changes/prompts';
import { withRepositoryOperation } from '../git/repository-operations';
import {
  captureRollback,
  rollbackSelected,
  validateNewFiles,
} from '../git/rollback';
import type { SourceControlModel } from './model';
import { requireLiveRepository, type SourceControlRuntime } from './writes';

export async function rollbackChanges(options: {
  runtime: SourceControlRuntime;
  model: SourceControlModel;
  id: string;
  paths: readonly string[];
}): Promise<void> {
  const { runtime, model, id, paths } = options;

  requireLiveRepository(runtime, model, id);
  const root = runtime.access.repository(id).rootUri;
  const files = model.workingFiles(id, paths);
  let closed = false;
  const subscription = runtime.access.api.onDidCloseRepository((closing) => {
    if (closing.rootUri.toString() === id) closed = true;
  });
  const requireCurrent = () => {
    requireLiveRepository(runtime, model, id);
    if (closed)
      throw new Error(
        'The repository closed. Refresh and review the selected files again.',
      );
    if (dirtySelectedDocuments(root, files).length)
      throw new Error(
        'Selected files have unsaved edits. Save or revert them before using Rollback.',
      );
  };

  try {
    requireCurrent();
    const plan = await captureRollback(runtime.cli, id, files);

    requireCurrent();
    const removeNew = 'Rollback and Delete New Files';
    const hasNew = plan.newFiles.some((file) => file.identity !== null);
    const useTrash =
      !vscode.env.remoteName &&
      vscode.workspace
        .getConfiguration('git')
        .get<boolean>('discardUntrackedChangesToTrash', true);
    const answer = await vscode.window.showWarningMessage(
      `Rollback changes in ${files.length} selected ${files.length === 1 ? 'file' : 'files'}?`,
      {
        modal: true,
        detail: `Staged and unstaged edits will be restored to the last commit.${hasNew ? ` New files are kept unless you choose to ${useTrash ? 'move them to Trash' : 'permanently delete them'}.` : ''}\n\n${files.map((file) => file.path).join('\n')}`,
      },
      'Rollback',
      ...(hasNew ? [removeNew] : []),
    );

    if (answer !== 'Rollback' && answer !== removeNew) return;
    await withRepositoryOperation(runtime.cli, id, async () => {
      requireCurrent();
      await rollbackSelected(runtime.cli, id, plan, requireCurrent);
      if (answer !== removeNew) return;
      requireCurrent();
      await validateNewFiles(plan);
      for (const file of plan.newFiles) {
        if (file.identity === null) continue;
        requireCurrent();
        await validateNewFiles({ ...plan, newFiles: [file] });
        await vscode.workspace.fs.delete(
          vscode.Uri.joinPath(root, ...file.path.split('/')),
          { useTrash },
        );
      }
    });
  } finally {
    subscription.dispose();
  }
}
