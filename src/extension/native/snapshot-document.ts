import type { TextDocumentContentProvider, Uri } from 'vscode';

/** Read-only text captured when a native diff opens, such as a symbolic link target. */
export class SnapshotDocumentProvider implements TextDocumentContentProvider {
  provideTextDocumentContent(uri: Uri): string {
    const text: unknown = JSON.parse(uri.query);

    if (typeof text !== 'string' || text.length > 65_536)
      throw new Error('Invalid diff snapshot.');

    return text;
  }
}
