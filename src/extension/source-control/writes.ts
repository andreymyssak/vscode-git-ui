import * as vscode from 'vscode';

import type { WorkingFile } from '../../shared/source-control';
import {
  dirtySelectedDocuments,
  messagePrompt,
  saveSelectedDocuments,
} from '../changes/prompts';
import type { SourceControlBackend } from '../git/source-control/index';
import { showOperationInfo } from '../native/operation-feedback';
import type { SourceControlModel } from './model';

export function requireLiveRepository(
  runtime: SourceControlBackend,
  model: SourceControlModel,
  id: string,
) {
  const repo = model.requireRepository(id);

  runtime.root(id);

  return repo;
}

export function requireSaved(
  root: vscode.Uri,
  files: readonly Pick<WorkingFile, 'path' | 'originalPath'>[],
): void {
  if (dirtySelectedDocuments(root, files).length)
    throw new Error(
      'Selected files have unsaved edits. Save them and review your selection before continuing.',
    );
}

export async function writeChanges(options: {
  runtime: SourceControlBackend;
  model: SourceControlModel;
  id: string;
  kind: 'commit' | 'stash' | 'stash-silently';
  nativePrompt: boolean;
  selection:
    { kind: 'checked' } | { kind: 'selected'; paths: readonly string[] };
  publish: () => void;
}): Promise<void> {
  const { runtime, model, id, kind } = options;
  const repo = requireLiveRepository(runtime, model, id);
  const mode = repo.commitMode;
  const amending = kind === 'commit' && mode.kind === 'amend';
  const currentFiles = () =>
    options.selection.kind === 'checked'
      ? amending
        ? model.workingFiles(
            id,
            model
              .requireRepository(id)
              .checked.selected()
              .map((file) => file.path),
          )
        : model.selectedFiles(id)
      : model.workingFiles(id, options.selection.paths);
  const label = options.selection.kind;
  const files = currentFiles();

  if (!files.length && !amending)
    throw new Error('Select at least one changed file.');
  const selection = JSON.stringify(files);
  const root = runtime.root(id);

  if (!(await saveSelectedDocuments(root, files))) return;
  requireLiveRepository(runtime, model, id);
  if (JSON.stringify(currentFiles()) !== selection)
    throw new Error(
      `The ${label} files changed. Review them before continuing.`,
    );
  const prepared = await runtime.prepareChanges({
    id,
    files,
    mode: amending ? mode : { kind: 'new' },
  });

  if (prepared.amendPublished) {
    const choice = await vscode.window.showWarningMessage(
      'The last commit is in known remote history. Amending changes its identity.',
      { modal: true },
      'Amend Commit',
    );

    if (choice !== 'Amend Commit') return;
  }

  requireLiveRepository(runtime, model, id);
  let message = kind === 'commit' ? model.draft(id) : 'Changes';

  if (kind === 'stash') {
    const answer = await vscode.window.showInputBox({
      title: 'Stash Selected Files',
      prompt: `${repo.info.label}: ${files.length} ${label} ${files.length === 1 ? 'file' : 'files'}. Stash name`,
      value: 'Changes',
      ignoreFocusOut: true,
    });

    if (answer === undefined) return;
    message = answer.trim() || 'Changes';
  }

  if (!message.trim() && kind === 'commit' && options.nativePrompt) {
    const answer = await messagePrompt({
      title: 'Commit Selected Files',
      prompt: `${repo.info.label}: ${files.length} ${label} ${files.length === 1 ? 'file' : 'files'}. Commit message`,
      draft: message,
      onDraft: (value) => {
        model.setDraft(id, value);
        options.publish();
      },
    });

    if (answer === undefined) return;
    message = answer;
    model.setDraft(id, message);
  }

  const draft = model.draft(id);

  if (!message.trim()) throw new Error('Enter a message before continuing.');
  requireSaved(root, files);
  const result = await prepared.write({
    kind: kind === 'commit' ? 'commit' : 'stash',
    message,
    beforeWrite: () => {
      requireLiveRepository(runtime, model, id);
      if (
        JSON.stringify(currentFiles()) !== selection ||
        (kind === 'commit' && model.draft(id) !== draft)
      )
        throw new Error(
          `The ${label} files or message changed. Review them before continuing.`,
        );
      requireSaved(root, files);
    },
  });

  repo.checked.clear(files.map((file) => file.path));
  if (kind === 'commit') model.committed(id);
  showOperationInfo(
    kind === 'commit'
      ? amending
        ? `Amended the last commit in ${repo.info.label}, ${result.sha.slice(0, 8)}.`
        : `Committed ${files.length} ${label} files in ${repo.info.label}, ${result.sha.slice(0, 8)}.`
      : `Stashed ${files.length} ${label} files in ${repo.info.label}.`,
  );
}
