import * as vscode from 'vscode';

import type { SourceControlRequest } from '../../shared/source-control';
import { saveSelectedDocuments } from '../changes/prompts';
import { deleteStashFiles, renameStash } from '../git/edit-stash';
import { withRepositoryOperation } from '../git/repository-operations';
import {
  applyStash,
  deleteStash,
  restoreStashFiles,
} from '../git/stash-operations';
import { readStashFiles } from '../git/stashes';
import type { SourceControlModel } from './model';
import type { SourceControlRuntime } from './writes';
import { requireLiveRepository, requireSaved } from './writes';

type SavedRequest =
  | {
      kind: 'restore-stash' | 'delete-stash' | 'rename-stash';
      repositoryId: string;
      sha: string;
    }
  | Extract<
      SourceControlRequest,
      { kind: 'restore-stash-files' | 'delete-stash-files' }
    >;

export function savedWriteDescription(request: SavedRequest): string {
  return request.kind === 'rename-stash'
    ? 'Renaming stash…'
    : request.kind === 'delete-stash' || request.kind === 'delete-stash-files'
      ? 'Deleting saved changes…'
      : 'Applying stash changes…';
}

export async function writeSaved(options: {
  runtime: SourceControlRuntime;
  model: SourceControlModel;
  request: SavedRequest;
}): Promise<void> {
  const { runtime, model, request } = options;
  const id = request.repositoryId;
  const sha = request.sha;
  const repo = requireLiveRepository(runtime, model, id);
  const stash = model.requireStash(id, sha);
  const keys = 'files' in request ? request.files : null;
  const files =
    keys === null
      ? await readStashFiles(runtime.cli, id, stash)
      : model.stashFiles(id, sha, keys);
  const root = runtime.access.repository(id).rootUri;
  let name: string | null = null;

  if (request.kind === 'rename-stash') {
    const answer = await vscode.window.showInputBox({
      title: 'Rename Stash',
      prompt: 'Stash name',
      value: stash.message,
      ignoreFocusOut: true,
    });

    if (answer === undefined) return;
    name = answer;
  } else if (
    request.kind === 'delete-stash' ||
    request.kind === 'delete-stash-files'
  ) {
    const label =
      request.kind === 'delete-stash' ? 'Delete Stash' : 'Delete Saved Files';
    const message =
      request.kind === 'delete-stash'
        ? `Delete stash "${stash.message}" from ${repo.info.label}? Restored files remain in the working tree.`
        : `Delete ${new Set(files.map((file) => file.path)).size} saved files from "${stash.message}"? All saved versions of these files will be removed. Working files remain unchanged.`;
    const answer = await vscode.window.showWarningMessage(
      message,
      label,
      'Cancel',
    );

    if (answer !== label) return;
  } else if (!(await saveSelectedDocuments(root, files))) return;
  requireLiveRepository(runtime, model, id);
  await withRepositoryOperation(runtime.cli, id, async () => {
    requireLiveRepository(runtime, model, id);
    model.requireStash(id, sha);
    if (
      keys !== null &&
      JSON.stringify(model.stashFiles(id, sha, keys)) !== JSON.stringify(files)
    )
      throw new Error(
        'The saved selection changed. Refresh and select it again.',
      );
    switch (request.kind) {
      case 'restore-stash':
        requireSaved(root, files);
        await applyStash(runtime.cli, id, sha);

        return;
      case 'restore-stash-files':
        requireSaved(root, files);
        await restoreStashFiles(runtime.cli, id, sha, files);

        return;
      case 'delete-stash':
        await deleteStash(runtime.cli, id, sha);

        return;
      case 'delete-stash-files': {
        const next = await deleteStashFiles(runtime.cli, id, sha, files);

        if (next !== null) await model.rememberStashRewrite(id, stash, next);

        return;
      }

      case 'rename-stash': {
        if (name === null) throw new Error('Enter a stash name.');
        const next = await renameStash(runtime.cli, id, sha, name);

        await model.rememberStashRewrite(id, stash, next);

        return;
      }
    }
  });
}
