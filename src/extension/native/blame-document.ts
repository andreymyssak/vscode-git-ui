import { isAbsolute, relative, sep } from 'node:path';

import * as vscode from 'vscode';
import { z } from 'zod';

import type { GitApiAccess } from '../git/api';
import type { BlameQuery } from '../git/blame-model';
import { containsRoot } from '../git/paths';

const gitMetadata = z.object({
  path: z.string().min(1).refine(isAbsolute),
  ref: z.string(),
});
const fullSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export type BlameDocument =
  | { kind: 'ready'; query: BlameQuery; documentVersion: number }
  | { kind: 'no-history' }
  | { kind: 'unsupported'; message: string };

export function blameFileUri(uri: vscode.Uri): vscode.Uri | null {
  if (uri.scheme === 'file') return uri;
  if (uri.scheme !== 'git') return null;
  try {
    const value: unknown = JSON.parse(uri.query);
    const metadata = gitMetadata.safeParse(value);

    return metadata.success ? vscode.Uri.file(metadata.data.path) : null;
  } catch {
    return null;
  }
}

export async function resolveBlameDocument(
  access: GitApiAccess,
  document: vscode.TextDocument,
): Promise<BlameDocument> {
  const unsupported = (message: string): BlameDocument => ({
    kind: 'unsupported',
    message,
  });
  const file = blameFileUri(document.uri);

  if (!file)
    return unsupported('Annotate a Git file or a historical Git revision.');
  const found = access.api.getRepository(file);

  if (!found)
    return unsupported('This file is outside an open Git repository.');
  const repositoryId = found.rootUri.toString();
  const repository = access.repository(repositoryId);

  if (!containsRoot(repository.rootUri.fsPath, file.fsPath))
    return unsupported('Select a file inside the Git repository.');
  const path = relative(repository.rootUri.fsPath, file.fsPath)
    .split(sep)
    .join('/');

  if (!path || path.includes('\0'))
    return unsupported('Select a file inside the Git repository.');
  const contents = document.getText();

  if (contents.includes('\0'))
    return unsupported('Binary files cannot be annotated.');
  if (!contents) return unsupported('This document has no lines to annotate.');
  const ignoreWhitespace = vscode.workspace
    .getConfiguration('git', file)
    .get<boolean>('blame.ignoreWhitespace', false);
  const ready = (source: BlameQuery['source']): BlameDocument => ({
    kind: 'ready',
    documentVersion: document.version,
    query: { repositoryId, source, ignoreWhitespace },
  });

  if (document.uri.scheme === 'git') {
    const value: unknown = JSON.parse(document.uri.query);
    const metadata = gitMetadata.parse(value);
    const { ref } = metadata;

    if (ref !== '' && ref !== '~') {
      if (fullSha.test(ref)) return ready({ kind: 'revision', path, sha: ref });
      if (!ref || ref.startsWith('-') || /[\0\r\n]/.test(ref))
        return unsupported('This Git revision cannot be annotated.');
      const commit = await repository.getCommit(ref);

      if (!fullSha.test(commit.hash))
        throw new Error('Git returned an invalid commit identity.');

      return ready({ kind: 'revision', path, sha: commit.hash });
    }
  }

  const headSha = repository.state.HEAD?.commit;

  if (!headSha) return { kind: 'no-history' };
  if (!fullSha.test(headSha))
    throw new Error('Git returned an invalid HEAD identity.');

  return ready({ kind: 'contents', path, headSha, contents });
}
