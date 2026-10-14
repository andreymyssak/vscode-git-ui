import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SourceControlOperation } from '../../../shared/source-control';
import { hasErrorCode } from '../../../shared/validation';
import { updateCheckout } from '../branch-update-target';
import type { GitCli } from '../cli';
import { readSelectedChangeRecovery } from '../selected-change-recovery';

type Cli = Pick<GitCli, 'run'>;

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function marker(directory: string, name: string) {
  const path = join(directory, name);

  try {
    const stat = await lstat(path);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('Cannot verify the current Git operation.');

    return [stat.ino, stat.mtimeMs, await readFile(path, 'utf8')];
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR'))
      return null;
    throw error;
  }
}

/** Git patch conflicts are distinct from Git's merge/rebase/sequencer operations. */
export async function readSourceControlOperation(
  cli: Cli,
  id: string,
  root: string,
): Promise<SourceControlOperation[]> {
  const directory = (
    await cli.run(id, ['rev-parse', '--absolute-git-dir'])
  ).replace(/\r?\n$/, '');

  for (const [name, kind] of [
    ['rebase-merge/head-name', 'rebase'],
    ['rebase-apply/head-name', 'rebase'],
    ['REVERT_HEAD', 'revert'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['MERGE_HEAD', 'merge'],
  ] as const) {
    const state = await marker(directory, name);

    if (state)
      return [
        {
          kind,
          paths: [],
          token: fingerprint([kind, state, await updateCheckout(cli, id)]),
        },
      ];
  }

  const sequence = await marker(directory, 'sequencer/todo');

  if (sequence) {
    const todo = sequence[2];

    if (typeof todo !== 'string' || !/^(?:revert|pick) /m.test(todo))
      throw new Error(
        'Review this Git sequence in native Source Control before aborting.',
      );
    const kind = /^revert /m.test(todo) ? 'revert' : 'cherry-pick';

    return [
      {
        kind,
        paths: [],
        token: fingerprint([kind, sequence, await updateCheckout(cli, id)]),
      },
    ];
  }

  const record = await readSelectedChangeRecovery(cli, id, root);

  if (record) {
    const checkout = await updateCheckout(cli, id);

    if (
      checkout.sha === record.head &&
      checkout.ref === record.branch &&
      (
        await cli.run(id, [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignored=matching',
          '--',
          ...record.paths.map((path) => `:(literal)${path}`),
        ])
      ).length
    )
      return [
        { kind: record.kind, paths: record.paths, token: fingerprint(record) },
      ];
  }

  const conflicts = (
    await cli.run(id, ['diff', '--name-only', '--diff-filter=U', '-z'])
  )
    .split('\0')
    .filter(Boolean);

  if (conflicts.length > 10_000)
    throw new Error(
      'There are too many unowned conflicts to discard together. Review them in native Source Control.',
    );

  return conflicts.length
    ? [
        {
          kind: 'conflicts',
          paths: conflicts,
          token: fingerprint([conflicts, await updateCheckout(cli, id)]),
        },
      ]
    : [];
}
