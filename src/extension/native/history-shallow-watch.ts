import { basename, dirname } from 'node:path';

import * as vscode from 'vscode';

import type { HistoryShallow } from '../git/history-shallow';

/** Simple patterns also observe Git metadata outside the workspace root. */
export function watchHistoryShallow(
  shallow: HistoryShallow,
  id: string,
  changed: () => void,
): vscode.Disposable {
  const owner = new AbortController();
  let watcher: vscode.FileSystemWatcher | null = null;

  void shallow
    .path(id, owner.signal)
    .then((path) => {
      if (owner.signal.aborted) return;
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(dirname(path)),
          basename(path),
        ),
      );
      watcher.onDidCreate(changed);
      watcher.onDidChange(changed);
      watcher.onDidDelete(changed);
      // Cover changes between the first snapshot and watcher installation.
      changed();
    })
    .catch(() => {
      // Native status events and fresh query checks still validate metadata.
    });

  return {
    dispose() {
      owner.abort();
      watcher?.dispose();
    },
  };
}
