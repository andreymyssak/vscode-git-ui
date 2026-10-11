import * as vscode from 'vscode';

import { commandId, extensionIdentity } from '../../shared/extension-identity';
import type { GitCommit } from '../git/api';
import type { BlameLine } from '../git/blame-model';

export function formatBlameLabel(line: BlameLine): string {
  if (line.kind === 'uncommitted') return 'Not committed yet';
  const date = new Intl.DateTimeFormat(undefined, {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(line.authorDate));
  const author = Array.from(line.authorName);
  const name =
    author.length > 14 ? author.slice(0, 13).join('') + '…' : line.authorName;

  return `${date} ${name}`;
}

export function createBlameHover(input: {
  line: BlameLine;
  documentUri: vscode.Uri;
  commit: GitCommit | null;
}): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  const { line } = input;

  if (line.kind === 'uncommitted')
    return markdown.appendText('Not committed yet');
  markdown.isTrusted = { enabledCommands: [commandId('open-blame-commit')] };
  markdown.appendText(
    `${line.authorName} <${line.authorEmail}>\n\n${new Date(line.authorDate).toLocaleString()}\n\n${input.commit?.message ?? line.summary}`,
  );
  markdown.appendCodeblock(line.sha, 'text');
  const payload = encodeURIComponent(
    JSON.stringify([
      { documentUri: input.documentUri.toString(), sha: line.sha },
    ]),
  );

  markdown.appendMarkdown(
    `\n\n[Open Commit in ${extensionIdentity.displayName}](command:${commandId('open-blame-commit')}?${payload})`,
  );

  return markdown;
}
