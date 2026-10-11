import * as vscode from 'vscode';

import type { WorkingFile } from '../git/working-changes';
import { showOperationError } from '../native/operation-feedback';

export function messagePrompt(options: {
  title: string;
  prompt: string;
  draft: string;
  onDraft: (value: string) => void;
}): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox();
    const subscriptions: vscode.Disposable[] = [];
    let accepted = false;

    input.title = options.title;
    input.prompt = options.prompt;
    input.value = options.draft;
    input.ignoreFocusOut = true;
    subscriptions.push(
      input.onDidChangeValue((value) => {
        options.onDraft(value);
      }),
    );
    subscriptions.push(
      input.onDidAccept(() => {
        if (!input.value.trim()) {
          void showOperationError('Enter a message to continue.');

          return;
        }

        accepted = true;
        resolve(input.value);
        input.hide();
      }),
    );
    subscriptions.push(
      input.onDidHide(() => {
        if (!accepted) resolve(undefined);
        for (const subscription of subscriptions) subscription.dispose();
        input.dispose();
      }),
    );
    input.show();
  });
}

export function dirtySelectedDocuments(
  root: vscode.Uri,
  files: readonly Pick<WorkingFile, 'path' | 'originalPath'>[],
): vscode.TextDocument[] {
  const targets = new Set(
    files
      .flatMap((file) => [file.path, file.originalPath])
      .map((path) => vscode.Uri.joinPath(root, ...path.split('/')).toString()),
  );

  return vscode.workspace.textDocuments.filter(
    (document) => document.isDirty && targets.has(document.uri.toString()),
  );
}

export async function saveSelectedDocuments(
  root: vscode.Uri,
  files: readonly Pick<WorkingFile, 'path' | 'originalPath'>[],
): Promise<boolean> {
  const dirty = dirtySelectedDocuments(root, files);

  if (!dirty.length) return true;
  const choice = await vscode.window.showWarningMessage(
    `Save ${dirty.length} unsaved affected ${dirty.length === 1 ? 'file' : 'files'} before continuing?`,
    'Save and Continue',
    'Cancel',
  );

  if (choice !== 'Save and Continue') return false;

  for (const document of dirty) if (!(await document.save())) return false;

  return true;
}
