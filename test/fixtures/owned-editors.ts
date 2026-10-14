import assert from 'node:assert/strict';
import { isAbsolute, relative, sep } from 'node:path';

import * as vscode from 'vscode';

export async function closeFixtureEditors({
  roots,
}: {
  roots: readonly string[];
}) {
  const owns = (document: vscode.TextDocument) =>
    document.uri.scheme === 'file' &&
    roots.some((root) => {
      const child = relative(vscode.Uri.file(root).fsPath, document.uri.fsPath);

      return (
        child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
      );
    });

  for (const document of vscode.workspace.textDocuments)
    if (document.isDirty && owns(document)) {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand(
        'workbench.action.revertAndCloseActiveEditor',
      );
    }

  assert.ok(
    !vscode.workspace.textDocuments.some(
      (document) => document.isDirty && owns(document),
    ),
    'Revert fixture-owned dirty documents before retiring their repositories.',
  );
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
