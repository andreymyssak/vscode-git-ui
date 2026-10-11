import { lstat, readlink } from 'node:fs/promises';

import * as vscode from 'vscode';

import {
  EMPTY_DOCUMENT_SCHEME,
  SNAPSHOT_DOCUMENT_SCHEME,
} from '../../shared/extension-identity';
import type { GitApiAccess } from '../git/api';
import type { GitCli } from '../git/cli';
import type { StashFile } from '../git/stashes';
import type { WorkingFile } from '../git/working-changes';

function fileUri(access: GitApiAccess, id: string, path: string): vscode.Uri {
  if (
    path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error('Invalid changed file path.');

  return vscode.Uri.joinPath(access.repository(id).rootUri, ...path.split('/'));
}

function empty(id: string, path: string, side: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: EMPTY_DOCUMENT_SCHEME,
    path: `/${side}/${path}`,
    query: id,
  });
}

export async function workingChangeUris(
  access: GitApiAccess,
  cli: GitCli,
  id: string,
  file: WorkingFile,
  index = false,
): Promise<{ original: vscode.Uri; modified: vscode.Uri }> {
  const current = fileUri(access, id, file.path);
  const old = fileUri(access, id, file.originalPath);
  const head = access.repository(id).state.HEAD?.commit;
  const existed = head
    ? Boolean(
        await cli.run(id, [
          'ls-tree',
          '-z',
          head,
          '--',
          `:(literal)${file.originalPath}`,
        ]),
      )
    : false;
  let present: boolean;
  let working = current;

  if (index)
    present = Boolean(
      await cli.run(id, [
        'ls-files',
        '--stage',
        '-z',
        '--',
        `:(literal)${file.path}`,
      ]),
    );
  else {
    try {
      const stat = await lstat(current.fsPath);

      if (stat.isSymbolicLink()) {
        working = vscode.Uri.from({
          scheme: SNAPSHOT_DOCUMENT_SCHEME,
          path: current.path,
          query: JSON.stringify(await readlink(current.fsPath)),
        });
      }

      present = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      present = false;
    }
  }

  return {
    original:
      existed && head
        ? access.api.toGitUri(old, head)
        : empty(id, file.path, 'original'),
    modified: present
      ? index
        ? access.api.toGitUri(current, '')
        : working
      : empty(id, file.path, 'modified'),
  };
}

export function stashChangeUris(
  access: GitApiAccess,
  id: string,
  file: StashFile,
): { original: vscode.Uri; modified: vscode.Uri } {
  return {
    original:
      file.oldRef === null
        ? empty(id, file.path, 'original')
        : access.api.toGitUri(
            fileUri(access, id, file.originalPath),
            file.oldRef,
          ),
    modified: file.deleted
      ? empty(id, file.path, 'modified')
      : access.api.toGitUri(fileUri(access, id, file.path), file.newRef),
  };
}

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
