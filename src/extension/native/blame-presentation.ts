import * as vscode from 'vscode';

import { commandId, extensionIdentity } from '../../shared/extension-identity';
import type { GitCommit } from '../git/api';
import type { BlameLine } from '../git/blame-model';

export function formatBlameLabel(line: BlameLine): string {
  if (line.kind === 'uncommitted') return 'Not committed yet';
  const timestamp = new Date(line.authorDate);
  const date = [
    String(timestamp.getDate()).padStart(2, '0'),
    String(timestamp.getMonth() + 1).padStart(2, '0'),
    timestamp.getFullYear(),
  ].join('.');
  const shortName = line.authorName.trim().split(/\s+/u).at(-1) ?? '';
  const author = Array.from(shortName);
  const name =
    author.length > 14 ? author.slice(0, 13).join('') + '…' : shortName;

  return `${date} ${name}`;
}

export function createBlameHover(input: {
  line: BlameLine;
  documentUri: vscode.Uri;
  commit: GitCommit | null;
  snapshotId: string;
}): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  const { line } = input;

  if (line.kind === 'uncommitted')
    return markdown.appendText('Not committed yet');
  markdown.isTrusted = { enabledCommands: [commandId('open-blame-commit')] };
  markdown.appendText(
    `${line.authorName} <${line.authorEmail}>\n\n${new Date(line.authorDate).toLocaleString()}\n\n${input.commit?.message ?? line.summary}`,
  );
  // Preserve native escaping while restoring wrapping between words.
  // Keep indentation nonbreaking to prevent code blocks, escape ordered
  // list markers, and display angle-form URLs as text, never actions.
  markdown.value = markdown.value
    .split('\n')
    .map((row) => {
      const indentation = /^(?:&nbsp;)*/u.exec(row)?.[0] ?? '';

      return (
        indentation + row.slice(indentation.length).replaceAll('&nbsp;', ' ')
      );
    })
    .join('\n')
    .replaceAll('.', '\\.')
    .replaceAll(':', '\\:')
    .replaceAll('@', '\\@')
    .replaceAll('<', '&lt;');
  const payload = encodeURIComponent(
    JSON.stringify([
      {
        documentUri: input.documentUri.toString(),
        sha: line.sha,
        filePath: line.originalPath,
        snapshotId: input.snapshotId,
      },
    ]),
  );

  markdown.appendMarkdown(
    `\n\n[Open Commit in ${extensionIdentity.displayName}](command:${commandId('open-blame-commit')}?${payload}) · ${line.sha.slice(0, 8)}`,
  );

  return markdown;
}
