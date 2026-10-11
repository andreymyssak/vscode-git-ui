import * as vscode from 'vscode';

import type { WorkingFile } from '../../shared/source-control';

/** Deleted rows remain useful for diffs; Open File opens existing working copies. */
export async function openWorkingFiles(
  root: vscode.Uri,
  files: readonly WorkingFile[],
): Promise<void> {
  let opened = 0;

  for (const file of files) {
    const uri = vscode.Uri.joinPath(root, ...file.path.split('/'));

    try {
      await vscode.workspace.fs.stat(uri);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      )
        continue;
      throw error;
    }

    await vscode.window.showTextDocument(uri, { preview: false });
    opened++;
  }

  if (!opened)
    throw new Error(
      'These files have no working copies. Use Show Changes to view their saved contents.',
    );
}
