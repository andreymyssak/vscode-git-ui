import * as vscode from 'vscode';

export async function openSourceControlDiff(
  uris: { original: vscode.Uri; modified: vscode.Uri },
  title: string,
  preview = true,
): Promise<void> {
  await vscode.commands.executeCommand(
    'vscode.diff',
    uris.original,
    uris.modified,
    title,
    { preview },
  );
}
