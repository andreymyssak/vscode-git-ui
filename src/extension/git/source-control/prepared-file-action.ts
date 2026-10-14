import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import * as vscode from 'vscode';

import type { WorkingFile } from '../../../shared/source-control';
import { hasErrorCode } from '../../../shared/validation';
import { createWorktreeIdentityResolver } from '../worktree-identity';
import type { BeforeWrite, RepositoryLease } from './repository';
import { readWorkingChanges } from './working-changes';
import { pathsOverlap } from './working-paths';

export type FileWriteAction =
  | 'delete-files'
  | 'accept-current'
  | 'accept-incoming'
  | 'stage-files'
  | 'unstage-files';

/** A deleted Git leaf may now be a directory. Never delete or stage its children. */
async function fileIdentity(
  root: string,
  path: string,
  kind: FileWriteAction,
  conflict = false,
): Promise<string | null> {
  const parts = path.split('/');

  if (
    isAbsolute(path) ||
    parts.some(
      (part) =>
        !part ||
        part.includes('\0') ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.git',
    ) ||
    (process.platform === 'win32' && path.includes('\\'))
  )
    throw new Error(
      'Invalid changed file path. Refresh and review your selection.',
    );
  try {
    for (let end = 1; end < parts.length; end++) {
      const parent = await lstat(join(root, ...parts.slice(0, end)));

      if (parent.isFile() && !parent.isSymbolicLink()) return null;
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error(
          'A selected file has a symbolic-link parent. Open its repository directly before continuing.',
        );
    }

    const absolute = join(root, ...parts);
    const stat = await lstat(absolute);
    const hash = createHash('sha256');

    hash.update(JSON.stringify([stat.dev, stat.ino, stat.mode]));
    if (stat.isSymbolicLink()) {
      if (kind === 'accept-current' || kind === 'accept-incoming')
        throw new Error(
          'Accept All supports regular text files. Resolve symbolic-link conflicts in native Source Control.',
        );
      hash.update(await readlink(absolute));
    } else if (stat.isFile()) {
      const content = await readFile(absolute);

      if (
        kind === 'accept-current' ||
        kind === 'accept-incoming' ||
        (kind === 'stage-files' && conflict)
      ) {
        let text: string | null;

        try {
          text = await vscode.workspace.decode(content, {
            uri: vscode.Uri.file(absolute),
          });
        } catch (error) {
          if (kind === 'stage-files' && content.includes(0)) text = null;
          else
            throw new Error(
              'Accept All supports text files. Resolve binary conflicts in native Source Control.',
              { cause: error },
            );
        }

        if (
          kind === 'stage-files' &&
          text !== null &&
          /^<{7,}\s|^={7,}\r?$|^>{7,}\s/m.test(text)
        )
          throw new Error(
            'Resolve the selected files before staging. Use Resolve in Merge Editor or Accept All Current/Incoming.',
          );
      }

      hash.update(content);
    } else
      throw new Error(
        'Select ordinary changed files, not directories or submodules.',
      );

    return hash.digest('hex');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

export async function prepareFileAction(
  lease: RepositoryLease,
  options: {
    id: string;
    files: readonly WorkingFile[];
    kind: FileWriteAction;
    protectionPaths: () => readonly string[];
  },
) {
  const { id, kind } = options;
  const files = [
    ...new Map(options.files.map((file) => [file.path, { ...file }])).values(),
  ];

  if (!files.length) throw new Error('Select at least one changed file.');
  if (
    (kind === 'accept-current' || kind === 'accept-incoming') &&
    files.some((file) => !/U|AA|DD/.test(file.status))
  )
    throw new Error(
      'Select only conflicted files. Refresh and review your selection.',
    );
  if (
    (kind === 'accept-current' || kind === 'accept-incoming') &&
    files.some((file) => !['UU', 'AA'].includes(file.status))
  )
    throw new Error(
      'Open deletion conflicts in native Source Control to choose which file to keep.',
    );
  if (
    kind === 'stage-files' &&
    files.some((file) => !file.working && !file.untracked)
  )
    throw new Error('Select files with working changes to stage.');
  if (
    kind === 'unstage-files' &&
    files.some((file) => !file.staged || /U|AA|DD/.test(file.status))
  )
    throw new Error(
      'Select staged files to unstage. Resolve conflicts in native Source Control.',
    );
  const paths = [
    ...new Set(
      files.flatMap((file) =>
        (kind === 'unstage-files' && /R/.test(file.status[0] ?? '')) ||
        (kind === 'stage-files' && /R/.test(file.status[1] ?? ''))
          ? [file.path, file.originalPath]
          : [file.path],
      ),
    ),
  ];

  for (const path of paths)
    if (
      isAbsolute(path) ||
      path.includes('\0') ||
      path
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            part.toLowerCase() === '.git',
        ) ||
      (process.platform === 'win32' && path.includes('\\'))
    )
      throw new Error(
        'Invalid changed file path. Refresh and review your selection.',
      );
  const selectionState = async () => {
    const head = await lease.cli
      .run(id, ['rev-parse', '--verify', 'HEAD'])
      .catch(async () =>
        lease.cli.run(id, ['symbolic-ref', '--quiet', 'HEAD']),
      );
    const branch = await lease.cli
      .run(id, ['symbolic-ref', '--quiet', 'HEAD'])
      .catch((error: unknown) => {
        if (!hasErrorCode(error, 1)) throw error;

        return null;
      });
    const index =
      kind === 'stage-files' || kind === 'unstage-files'
        ? await lease.cli.run(id, [
            'ls-files',
            '--stage',
            '-v',
            '-z',
            '--',
            ...paths.map((path) => `:(literal)${path}`),
          ])
        : null;

    return {
      hasHead: !head.startsWith('refs/'),
      fingerprint: JSON.stringify([head, branch, index]),
    };
  };

  const capturedState = await selectionState();
  const requireSavedSelection = async () => {
    if (kind !== 'delete-files' && kind !== 'stage-files') return;
    const protectedPaths = options.protectionPaths();

    if (!protectedPaths.length) return;
    const canonical = createWorktreeIdentityResolver();
    const protectedIdentities = new Set(
      await Promise.all(protectedPaths.map(canonical)),
    );

    if (
      (
        await Promise.all(
          paths.map((path) => canonical(join(lease.root.fsPath, path))),
        )
      ).some((path) => protectedIdentities.has(path))
    )
      throw new Error(
        'Selected files have unsaved edits. Save them and review your selection before continuing.',
      );
  };

  const requireSelection = async () => {
    lease.current();
    const current = await readWorkingChanges(lease.cli, id);

    if (
      files.some(
        (file) =>
          !current.some(
            (entry) => JSON.stringify(entry) === JSON.stringify(file),
          ),
      )
    )
      throw new Error(
        'Selected files changed. Refresh and review them before continuing.',
      );
    if ((await selectionState()).fingerprint !== capturedState.fingerprint)
      throw new Error(
        'The checked-out branch, HEAD or staged files changed. Refresh and review the selected files.',
      );
    if (
      (kind === 'stage-files' || kind === 'unstage-files') &&
      current.some(
        (entry) =>
          !files.some(
            (file) =>
              file.path === entry.path &&
              file.originalPath === entry.originalPath,
          ) &&
          [
            entry.path,
            ...(/R/.test(entry.status[kind === 'stage-files' ? 1 : 0] ?? '')
              ? [entry.originalPath]
              : []),
          ].some((path) =>
            paths.some((selected) => pathsOverlap(path, selected)),
          ),
      )
    )
      throw new Error(
        'Selected paths overlap other changes. Select all affected files before staging or unstaging.',
      );
    lease.current();
  };

  await requireSelection();
  await requireSavedSelection();
  const identities = await Promise.all(
    kind === 'unstage-files'
      ? []
      : paths.map((path) =>
          fileIdentity(
            lease.root.fsPath,
            path,
            kind,
            files.some(
              (file) => file.path === path && /U|AA|DD/.test(file.status),
            ),
          ),
        ),
  );

  if (
    kind === 'delete-files' &&
    identities.every((identity) => identity === null)
  )
    throw new Error(
      'The selected files have no working copies to move to Trash.',
    );

  return {
    async write({ beforeWrite }: { beforeWrite: BeforeWrite }) {
      return lease.write(beforeWrite, async (_cli, repository) => {
        await requireSelection();
        for (const [index, path] of (kind === 'unstage-files'
          ? []
          : paths
        ).entries())
          if (
            (await fileIdentity(
              lease.root.fsPath,
              path,
              kind,
              files.some(
                (file) => file.path === path && /U|AA|DD/.test(file.status),
              ),
            )) !== identities[index]
          )
            throw new Error(
              'A selected file changed while confirming. Review it before continuing.',
            );
        beforeWrite();
        await requireSavedSelection();
        const resources = files.map((file) =>
          vscode.Uri.joinPath(lease.root, ...file.path.split('/')),
        );

        switch (kind) {
          case 'delete-files':
            for (const [index, uri] of resources.entries()) {
              if (identities[index] === null) continue;
              const file = files[index];

              if (
                !file ||
                (await fileIdentity(lease.root.fsPath, file.path, kind)) !==
                  identities[index]
              )
                throw new Error(
                  'A selected file changed before deletion. Remaining files were kept; review them before continuing.',
                );
              lease.current();
              beforeWrite();
              await requireSavedSelection();
              await vscode.workspace.fs.delete(uri, {
                useTrash: true,
                recursive: false,
              });
            }

            return;
          case 'stage-files':
          case 'unstage-files': {
            // The public Git API treats wildcard names as pathspecs and rewrites Unix backslashes.
            // Choose literal pathspecs before dispatch for these names; never retry a failed write.
            if (
              paths.some(
                (path) => path.startsWith(':') || /[\\*?[\]]/.test(path),
              )
            ) {
              const args =
                kind === 'stage-files'
                  ? ['add', '-A']
                  : capturedState.hasHead
                    ? ['reset', '-q', 'HEAD']
                    : ['rm', '--cached', '-r'];

              await _cli.run(id, [
                '--literal-pathspecs',
                ...args,
                '--',
                ...paths,
              ]);
              await repository.status();
            } else {
              const absolute = paths.map(
                (path) =>
                  vscode.Uri.joinPath(lease.root, ...path.split('/')).fsPath,
              );

              if (kind === 'stage-files') await repository.add(absolute);
              else await repository.revert(absolute);
            }

            return;
          }

          case 'accept-current':
          case 'accept-incoming':
            // The built-in merge-conflict extension accepts resource objects, not bare URIs.
            await vscode.commands.executeCommand(
              kind === 'accept-current'
                ? 'merge-conflict.accept.all-current'
                : 'merge-conflict.accept.all-incoming',
              ...resources.map((resourceUri) => ({ resourceUri })),
            );
        }
      });
    },
  };
}
