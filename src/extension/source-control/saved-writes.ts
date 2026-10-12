import * as vscode from 'vscode';

import type { SourceControlRequest } from '../../shared/source-control';
import { saveSelectedDocuments } from '../changes/prompts';
import type { SourceControlBackend } from '../git/source-control/index';
import type { SourceControlModel } from './model';
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
  runtime: SourceControlBackend;
  model: SourceControlModel;
  request: SavedRequest;
}): Promise<void> {
  const { runtime, model, request } = options;
  const id = request.repositoryId;
  const sha = request.sha;
  const repo = requireLiveRepository(runtime, model, id);
  const stash = model.requireStash(id, sha);
  const prepared = runtime.prepareStash({ id, sha });
  const keys = 'files' in request ? request.files : null;
  const files =
    keys === null
      ? await runtime.stashFiles(id, stash)
      : model.stashFiles(id, sha, keys);
  const root = runtime.root(id);
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
  const beforeWrite = () => {
    requireLiveRepository(runtime, model, id);
    model.requireStash(id, sha);
    if (
      keys !== null &&
      JSON.stringify(model.stashFiles(id, sha, keys)) !== JSON.stringify(files)
    )
      throw new Error(
        'The saved selection changed. Refresh and select it again.',
      );
    if (
      request.kind === 'restore-stash' ||
      request.kind === 'restore-stash-files'
    )
      requireSaved(root, files);
  };

  switch (request.kind) {
    case 'restore-stash':
      await prepared.write({ action: { kind: 'restore' }, beforeWrite });

      return;
    case 'restore-stash-files':
      await prepared.write({
        action: { kind: 'restore-files', files },
        beforeWrite,
      });

      return;
    case 'delete-stash':
      await prepared.write({ action: { kind: 'delete' }, beforeWrite });

      return;
    case 'delete-stash-files': {
      const next = await prepared.write({
        action: { kind: 'delete-files', files },
        beforeWrite,
      });

      if (next !== null) await model.rememberStashRewrite(id, stash, next);

      return;
    }

    case 'rename-stash': {
      if (name === null) throw new Error('Enter a stash name.');
      const next = await prepared.write({
        action: { kind: 'rename', name },
        beforeWrite,
      });

      if (next !== null) await model.rememberStashRewrite(id, stash, next);

      return;
    }
  }
}
