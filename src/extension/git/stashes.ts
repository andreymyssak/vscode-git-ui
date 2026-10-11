import { win32 } from 'node:path';

import type { Stash, StashFile } from '../../shared/source-control';
import type { GitCli } from './cli';
import { readObjectParents } from './parents';

export type { Stash, StashFile } from '../../shared/source-control';

type Reader = Pick<GitCli, 'run'>;

export function requireStashIdentity(sha: string): void {
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha))
    throw new Error('Select a full stash object identity.');
}

function pathFromGit(path: string, platform: string): string {
  const parts = path.split(platform === 'win32' ? /[\\/]/ : '/');

  if (
    !path ||
    path.startsWith('/') ||
    (platform === 'win32' &&
      (win32.isAbsolute(path) || /^[a-z]:/i.test(path))) ||
    path.includes('\0') ||
    parts.some((part) => part === '..' || part === '.' || !part)
  )
    throw new Error('Git returned an invalid stash path.');

  return path;
}

export function parseStashes(output: string): Stash[] {
  if (!output) return [];
  const fields = output.split('\0');

  if (fields.pop() !== '' || fields.length % 5 !== 0)
    throw new Error('Git returned an incomplete stash listing.');
  const stashes: Stash[] = [];

  for (let i = 0; i < fields.length; i += 5) {
    const sha = fields[i] ?? '';
    const selector = fields[i + 1] ?? '';
    const message = fields[i + 2] ?? '';
    const date = fields[i + 3] ?? '';
    const parents = (fields[i + 4] ?? '').split(' ');

    requireStashIdentity(sha);
    parents.forEach(requireStashIdentity);
    const base = parents[0];

    if (
      !base ||
      (parents.length !== 2 && parents.length !== 3) ||
      !/^stash@\{\d+\}$/.test(selector) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(
        date,
      ) ||
      !Number.isFinite(Date.parse(date))
    )
      throw new Error('Git returned invalid stash metadata.');
    stashes.push({ sha, selector, message, date, base });
  }

  return stashes;
}

export async function readStashes(cli: Reader, id: string): Promise<Stash[]> {
  return parseStashes(
    await cli.run(id, [
      'stash',
      'list',
      '-z',
      '--format=%H%x00%gd%x00%gs%x00%cI%x00%P',
    ]),
  );
}

export function parseStashFiles(
  output: string,
  snapshot: StashFile['snapshot'],
  base: string | null,
  ref: string,
  platform: string = process.platform,
): StashFile[] {
  if (!output) return [];
  const fields = output.split('\0');

  if (fields.pop() !== '')
    throw new Error('Git returned an incomplete stash file listing.');
  const files: StashFile[] = [];

  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';

    if (!/^(?:[AMDT]|[RC](?:100|[1-9]?\d))$/.test(status))
      throw new Error('Git returned an invalid stash file status.');
    const originalPath = pathFromGit(fields[i++] ?? '', platform);
    const path =
      status.startsWith('R') || status.startsWith('C')
        ? pathFromGit(fields[i++] ?? '', platform)
        : originalPath;

    files.push({
      path,
      originalPath,
      status,
      snapshot,
      oldRef: status === 'A' || status.startsWith('C') ? null : base,
      newRef: ref,
      deleted: status === 'D',
    });
  }

  return files;
}

async function snapshotFiles(
  cli: Reader,
  id: string,
  snapshot: StashFile['snapshot'],
  base: string | null,
  ref: string,
): Promise<StashFile[]> {
  return parseStashFiles(
    await cli.run(
      id,
      base === null
        ? [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--name-status',
            '-r',
            '-z',
            '-M',
            ref,
            '--',
          ]
        : [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--name-status',
            '-z',
            '-M',
            base,
            ref,
            '--',
          ],
    ),
    snapshot,
    base,
    ref,
  );
}

export async function readStashFiles(
  cli: Reader,
  id: string,
  stash: Stash,
): Promise<StashFile[]> {
  requireStashIdentity(stash.sha);
  const parents = await readObjectParents(cli, id, stash.sha);
  const [base, index, untracked] = parents;

  if (!base || !index || parents.length > 3 || base !== stash.base)
    throw new Error('The selected stash changed. Refresh and select it again.');
  const [workingFiles, indexFiles, differentFiles, untrackedFiles] =
    await Promise.all([
      snapshotFiles(cli, id, 'working', base, stash.sha),
      snapshotFiles(cli, id, 'index', base, index),
      cli.run(id, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '--no-renames',
        '-z',
        index,
        stash.sha,
        '--',
      ]),
      untracked
        ? snapshotFiles(cli, id, 'untracked', null, untracked)
        : Promise.resolve([]),
    ]);
  const differences = new Set(differentFiles.split('\0').filter(Boolean));

  return [
    ...workingFiles,
    ...indexFiles.filter(
      (file) =>
        differences.has(file.path) || differences.has(file.originalPath),
    ),
    ...untrackedFiles,
  ];
}
