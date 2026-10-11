import * as vscode from 'vscode';

import { SNAPSHOT_DOCUMENT_SCHEME } from '../../shared/extension-identity';
import type { WorkingFile } from '../../shared/source-control';

/** The active tab stays available when a toolbar click moves focus into the webview. */
export function openedChangePath(
  root: vscode.Uri,
  files: readonly WorkingFile[],
): string | null {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const candidates =
    input instanceof vscode.TabInputTextDiff
      ? [input.modified, input.original]
      : input instanceof vscode.TabInputText
        ? [input.uri]
        : [vscode.window.activeTextEditor?.document.uri];

  for (const uri of candidates) {
    if (!uri || !['file', 'git', SNAPSHOT_DOCUMENT_SCHEME].includes(uri.scheme))
      continue;
    const file = files.find((file) =>
      [file.path, file.originalPath].some((path) => {
        const current = vscode.Uri.joinPath(root, ...path.split('/'));

        return (
          current.fsPath === uri.fsPath && current.authority === uri.authority
        );
      }),
    );

    if (file) return file.path;
  }

  return null;
}
