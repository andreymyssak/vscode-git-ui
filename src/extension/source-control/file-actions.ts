import * as vscode from 'vscode';

import type { SourceControlRequest } from '../../shared/source-control';
import { saveSelectedDocuments } from '../changes/prompts';
import type { SourceControlBackend } from '../git/source-control/index';
import type { SourceControlModel } from './model';
import { requireLiveRepository, requireSaved } from './writes';

export async function writeWorkingFiles(options: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  request: Extract<
    SourceControlRequest,
    {
      kind:
        | 'delete-files'
        | 'accept-current'
        | 'accept-incoming'
        | 'stage-files'
        | 'unstage-files';
    }
  >;
}): Promise<void> {
  const { runtime, model, request } = options;
  const id = request.repositoryId;

  requireLiveRepository(runtime, model, id);
  const files = model.workingFiles(
    id,
    request.paths,
    request.kind === 'stage-files'
      ? 'working'
      : request.kind === 'unstage-files'
        ? 'index'
        : undefined,
  );
  const root = runtime.root(id);
  const beforeWrite = () => {
    requireLiveRepository(runtime, model, id);
    if (request.kind === 'delete-files' || request.kind === 'stage-files')
      requireSaved(root, files);
  };

  if (
    request.kind === 'stage-files' &&
    !(await saveSelectedDocuments(root, files))
  )
    return;
  beforeWrite();
  const prepared = await runtime.prepareFileAction({
    id,
    files,
    kind: request.kind,
  });

  if (request.kind === 'delete-files') {
    const action =
      process.platform === 'win32' ? 'Move to Recycle Bin' : 'Move to Trash';
    const choice = await vscode.window.showWarningMessage(
      `Delete ${files.length} selected ${files.length === 1 ? 'file' : 'files'}?`,
      {
        modal: true,
        detail: `Working files will be moved to ${process.platform === 'win32' ? 'the Recycle Bin' : 'Trash'}. Staged versions will be kept.\n\n${files.map((file) => file.path).join('\n')}`,
      },
      action,
    );

    if (choice !== action) return;
  }

  await prepared.write({ beforeWrite });
}

export async function inspectWorkingFiles(options: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  request: Extract<
    SourceControlRequest,
    { kind: 'resolve-conflicts' | 'reveal-in-os' | 'reveal-in-explorer' }
  >;
}): Promise<void> {
  const { runtime, model, request } = options;
  const id = request.repositoryId;

  requireLiveRepository(runtime, model, id);
  const files = model.workingFiles(id, request.paths);
  const root = runtime.root(id);

  if (request.kind === 'resolve-conflicts') {
    const current = await runtime.workingChanges(id);

    for (const file of files) {
      requireLiveRepository(runtime, model, id);
      if (
        !current.some(
          (item) =>
            item.path === file.path && ['UU', 'AA'].includes(item.status),
        )
      )
        throw new Error(
          'This file is no longer a conflict supported by the merge editor. Refresh and review it.',
        );
      await vscode.commands.executeCommand(
        'git.openMergeEditor',
        vscode.Uri.joinPath(root, ...file.path.split('/')),
      );
    }

    return;
  }

  if (
    !files.some((file) => file.path === request.path) &&
    !files.every((file) => file.path.startsWith(`${request.path}/`))
  )
    throw new Error(
      'Reveal a selected file or its folder. Refresh and review your selection.',
    );
  await vscode.commands.executeCommand(
    request.kind === 'reveal-in-os' ? 'revealFileInOS' : 'revealInExplorer',
    vscode.Uri.joinPath(root, ...request.path.split('/')),
  );
}
