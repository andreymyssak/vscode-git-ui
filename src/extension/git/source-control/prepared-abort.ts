import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { SourceControlOperation } from '../../../shared/source-control';
import { hasErrorCode } from '../../../shared/validation';
import {
  clearSelectedChangeRecovery,
  readSelectedChangeRecovery,
  safeRecoveryPath,
} from '../selected-change-recovery';
import { requireNoGitOperation } from '../working-tree-state';
import { createWorktreeIdentityResolver } from '../worktree-identity';
import { readSourceControlOperation } from './operation-state';
import type { BeforeWrite, RepositoryLease } from './repository';

export type NativeAbortKind = Extract<
  SourceControlOperation['kind'],
  'merge' | 'rebase' | 'cherry-pick' | 'revert'
>;

async function workingIdentity(
  root: string,
  path: string,
): Promise<string | null> {
  if (!safeRecoveryPath(path)) throw new Error('Invalid recovery file path.');
  const parts = path.split('/');

  try {
    for (let end = 1; end < parts.length; end++) {
      const parent = await lstat(join(root, ...parts.slice(0, end)));

      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error(
          'A recovery file has a changed or symbolic-link parent. Review it before aborting.',
        );
    }

    const stat = await lstat(join(root, path));
    const hash = createHash('sha256');

    hash.update(JSON.stringify([stat.dev, stat.ino, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(await readlink(join(root, path)));
    else if (stat.isFile()) hash.update(await readFile(join(root, path)));
    else
      throw new Error(
        'A recovery path is now a directory or submodule. Review it before aborting.',
      );

    return hash.digest('hex');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function prepareSourceControlAbort(
  lease: RepositoryLease,
  { id, token }: { id: string; token: string },
  nativeAbort: (kind: NativeAbortKind) => Promise<void>,
) {
  const operation = (
    await readSourceControlOperation(lease.cli, id, lease.root.fsPath)
  )[0];

  if (!operation || operation.token !== token)
    throw new Error(
      'The operation changed or is no longer active. Refresh before aborting.',
    );
  const scoped =
    operation.kind === 'cherry-pick-files' ||
    operation.kind === 'revert-files' ||
    operation.kind === 'conflicts';
  const paths = scoped ? [...operation.paths] : [];
  const snapshot = async () => {
    const [index, status, identities, workingDiff, nativeFiles] =
      await Promise.all([
        lease.cli.run(id, [
          'ls-files',
          '--stage',
          '-z',
          '--',
          ...paths.map((path) => `:(literal)${path}`),
        ]),
        lease.cli.run(id, [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignored=matching',
          '--',
          ...paths.map((path) => `:(literal)${path}`),
        ]),
        Promise.all(
          paths.map((path) => workingIdentity(lease.root.fsPath, path)),
        ),
        lease.cli.run(id, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--binary',
          '--no-color',
          '--',
          ...paths.map((path) => `:(literal)${path}`),
        ]),
        scoped ? Promise.resolve([]) : nativeWorkingFiles(lease, id),
      ]);

    return {
      fingerprint: JSON.stringify([
        index,
        status,
        identities,
        workingDiff,
        nativeFiles,
      ]),
      identities,
    };
  };

  const captured = await snapshot();
  const record =
    scoped && operation.kind !== 'conflicts'
      ? await readSelectedChangeRecovery(lease.cli, id, lease.root.fsPath)
      : null;

  if (scoped)
    await requireNoGitOperation(lease.cli, id, 'aborting the selected changes');
  lease.current();

  return {
    operation,
    async write({
      beforeWrite,
      protectionPaths,
    }: {
      beforeWrite: BeforeWrite;
      protectionPaths: () => readonly string[];
    }) {
      await lease.write(beforeWrite, async (cli, repository) => {
        const verify = async () => {
          lease.current();
          const fresh = (
            await readSourceControlOperation(cli, id, lease.root.fsPath)
          )[0];

          if (
            !fresh ||
            fresh.token !== token ||
            (await snapshot()).fingerprint !== captured.fingerprint
          )
            throw new Error(
              'The operation or affected files changed while confirming. Refresh and review them before aborting.',
            );
          if (scoped)
            await requireNoGitOperation(
              cli,
              id,
              'aborting the selected changes',
            );
          const canonical = createWorktreeIdentityResolver();
          const protectedFiles = protectionPaths();

          if (scoped) {
            const protectedIdentities = new Set(
              await Promise.all(protectedFiles.map(canonical)),
            );

            if (
              (
                await Promise.all(
                  paths.map((path) => canonical(join(lease.root.fsPath, path))),
                )
              ).some((path) => protectedIdentities.has(path))
            )
              throw new Error(
                'Save unsaved edits in the affected files before aborting.',
              );
          } else if (protectedFiles.length)
            throw new Error(
              'Save unsaved file edits before aborting the Git operation.',
            );
          lease.current();
          beforeWrite();
        };

        await repository.status();
        await verify();
        switch (operation.kind) {
          case 'merge':
          case 'rebase':
          case 'cherry-pick':
          case 'revert':
            await nativeAbort(operation.kind);
            if (
              (await readSourceControlOperation(cli, id, lease.root.fsPath))[0]
                ?.token === token
            )
              throw new Error(
                'The Git operation is still active. Review native Source Control before retrying Abort.',
              );
            break;
          case 'cherry-pick-files':
          case 'revert-files':
          case 'conflicts': {
            // Git has no public API for restoring both unmerged index stages and worktree paths.
            // Unstaging a patch's addition makes it unknown to HEAD/index. Restore known leaves
            // and remove only the recorded new leaves, which were absent before application.
            const headPaths = new Set(
              (
                await cli.run(id, [
                  '--literal-pathspecs',
                  'ls-tree',
                  '-r',
                  '--full-tree',
                  '--name-only',
                  '-z',
                  'HEAD',
                  '--',
                  ...paths,
                ])
              )
                .split('\0')
                .filter(Boolean),
            );
            const indexPaths = new Set(
              (
                await cli.run(id, [
                  'ls-files',
                  '-z',
                  '--',
                  ...paths.map((path) => `:(literal)${path}`),
                ])
              )
                .split('\0')
                .filter(Boolean),
            );
            const known = paths.filter(
              (path) => headPaths.has(path) || indexPaths.has(path),
            );

            await verify();
            if (known.length)
              await cli.runWithInput(
                id,
                [
                  'restore',
                  '--source=HEAD',
                  '--staged',
                  '--worktree',
                  '--pathspec-from-file=-',
                  '--pathspec-file-nul',
                ],
                known.map((path) => `:(literal)${path}\0`).join(''),
              );
            for (const [index, path] of paths.entries()) {
              if (headPaths.has(path)) continue;
              lease.current();
              beforeWrite();
              // Re-check parent/leaf types after restore; never recursively remove directories.
              const identity = await workingIdentity(lease.root.fsPath, path);
              const expected = indexPaths.has(path)
                ? null
                : captured.identities[index];

              if (identity !== expected)
                throw new Error(
                  'A recovery file changed before removal. Remaining files were kept. Review them before aborting again.',
                );
              if (identity !== null)
                await unlink(join(lease.root.fsPath, path));
            }

            if (record) await clearSelectedChangeRecovery(cli, id, record);
            break;
          }
        }

        await repository.status();
      });
    },
  };
}

/** Git filters can hide saved edits from diff/status. Capture raw stat times at nanosecond precision. */
async function nativeWorkingFiles(lease: RepositoryLease, id: string) {
  const directory = (
    await lease.cli.run(id, ['rev-parse', '--absolute-git-dir'])
  ).replace(/\r?\n$/, '');
  const refs = new Set([
    (
      await lease.cli.run(id, ['rev-parse', '--verify', 'HEAD^{commit}'])
    ).trim(),
  ]);
  const original = await lease.cli
    .run(id, ['rev-parse', '--verify', '--quiet', 'ORIG_HEAD^{commit}'])
    .catch((error: unknown) => {
      if (hasErrorCode(error, 1)) return '';
      throw error;
    });

  if (original.trim()) refs.add(original.trim());
  for (const name of [
    'rebase-merge/orig-head',
    'rebase-apply/orig-head',
    'sequencer/head',
  ]) {
    try {
      const path = join(directory, name);
      const stat = await lstat(path);

      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256)
        throw new Error('Cannot verify the original Git operation checkout.');
      const ref = (await readFile(path, 'utf8')).trim();

      if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(ref))
        throw new Error('Cannot verify the original Git operation checkout.');
      refs.add(ref);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR'))
        continue;
      throw error;
    }
  }

  // Abort can restore an ignored file removed from the current index. Include both checkout trees.
  const treePaths = (
    await Promise.all(
      [...refs].map((ref) =>
        lease.cli.run(id, [
          'ls-tree',
          '-r',
          '--full-tree',
          '--name-only',
          '-z',
          ref,
        ]),
      ),
    )
  ).flatMap((value) => value.split('\0').filter(Boolean));
  const paths = [
    ...new Set([
      ...treePaths,
      ...(
        await lease.cli.run(id, [
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
        ])
      )
        .split('\0')
        .filter(Boolean),
    ]),
  ].sort();
  const result: (readonly [string, string | null])[] = [];

  for (let start = 0; start < paths.length; start += 64) {
    result.push(
      ...(await Promise.all(
        paths.slice(start, start + 64).map(async (path) => {
          if (!safeRecoveryPath(path))
            throw new Error('Invalid Git working file path.');
          try {
            const stat = await lstat(join(lease.root.fsPath, path), {
              bigint: true,
            });

            return [
              path,
              [
                stat.dev,
                stat.ino,
                stat.mode,
                stat.size,
                stat.mtimeNs,
                stat.ctimeNs,
              ]
                .map(String)
                .join(':'),
            ] as const;
          } catch (error) {
            if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR'))
              return [path, null] as const;
            throw error;
          }
        }),
      )),
    );
  }

  return { refs: [...refs].sort(), files: result };
}
