import * as vscode from 'vscode';

import { dirtySelectedDocuments } from '../changes/prompts';
import type { SourceControlBackend } from '../git/source-control/index';
import type { SourceControlModel } from './model';
import { requireLiveRepository } from './writes';

export async function rollbackChanges(options: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  id: string;
  paths: readonly string[];
}): Promise<void> {
  const { runtime, model, id, paths } = options;

  requireLiveRepository(runtime, model, id);
  const root = runtime.root(id);
  const files = model.workingFiles(id, paths);
  const requireCurrent = () => {
    requireLiveRepository(runtime, model, id);
    if (dirtySelectedDocuments(root, files).length)
      throw new Error(
        'Selected files have unsaved edits. Save or revert them before using Rollback.',
      );
  };

  requireCurrent();
  const prepared = await runtime.prepareRollback({ id, files });

  requireCurrent();
  const removeNew = 'Rollback and Delete New Files';
  const hasNew = prepared.hasNewFiles;
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
  await prepared.write({
    deleteNewFiles: answer === removeNew,
    useTrash,
    beforeWrite: requireCurrent,
  });
}
