import * as vscode from 'vscode';

import type { OperationDialogs } from '../git/operations';

export const operationDialogs: OperationDialogs = {
  async remoteCheckout(ref, locals) {
    const choices = locals.map((local) => ({
      label: local.name,
      description: 'Existing tracking branch',
      local,
    }));
    const choice = await vscode.window.showQuickPick(
      [
        ...choices,
        {
          label: 'Create a tracking branch',
          description: ref.name,
          local: null,
        },
      ],
      { placeHolder: `Checkout ${ref.name}` },
    );

    if (!choice) return null;
    if (choice.local)
      return {
        kind: 'existing',
        refId: choice.local.id,
        expectedSha: choice.local.sha,
      };
    const name = await askBranchName(
      ref.name.replace(`${ref.remote ?? ref.name.split('/')[0]}/`, ''),
      'Create a tracking branch and switch to it',
    );

    return name === null ? null : { kind: 'create', name };
  },
};
export async function askBranchName(
  value = '',
  prompt = 'Create a branch without switching to it',
): Promise<string | null> {
  return (
    (await vscode.window.showInputBox({
      title: 'Create Branch',
      prompt,
      value,
      ignoreFocusOut: true,
    })) ?? null
  );
}

export async function askCommitMessage(
  message: string,
): Promise<string | null> {
  const document = await vscode.workspace.openTextDocument({
    // git-commit adds native Commit/Cancel controls for a different workflow.
    language: 'plaintext',
    content: message,
  });

  await vscode.window.showTextDocument(document, { preview: false });
  const choice = await vscode.window.showInformationMessage(
    'Edit the commit message in the editor, then choose Apply. Cancel leaves the commit unchanged.',
    'Apply',
    'Cancel',
  );

  return choice === 'Apply' && !document.isClosed ? document.getText() : null;
}

export async function askTagName(): Promise<string | null> {
  return (
    (await vscode.window.showInputBox({
      title: 'Create Tag',
      prompt: 'Create a tag at the selected commit',
      ignoreFocusOut: true,
    })) ?? null
  );
}

export async function confirmDrop(
  branch: string,
  count: number,
): Promise<boolean> {
  return (
    (await vscode.window.showInformationMessage(
      `Drop ${count} commit${count === 1 ? '' : 's'} from "${branch}"? Their changes will be removed.`,
      'Drop',
      'Cancel',
    )) === 'Drop'
  );
}

export async function askSquashMessage(
  message: string,
  branch: string,
  count: number,
): Promise<string | null> {
  const document = await vscode.workspace.openTextDocument({
    language: 'plaintext',
    content: message,
  });

  await vscode.window.showTextDocument(document, { preview: false });
  const choice = await vscode.window.showInformationMessage(
    `Squash ${count} commits on "${branch}" into one commit. Edit the combined message, then choose Apply. This rewrites the selected local history. Cancel leaves the commits unchanged.`,
    'Apply',
    'Cancel',
  );

  return choice === 'Apply' && !document.isClosed ? document.getText() : null;
}

export async function askRenameBranch(name: string): Promise<string | null> {
  return (
    (await vscode.window.showInputBox({
      title: 'Rename Branch',
      prompt: `Rename ${name}`,
      value: name,
      ignoreFocusOut: true,
    })) ?? null
  );
}
