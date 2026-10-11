import type { GitCli } from './cli';
import { deleteStashEntry } from './delete-stash';
import type { Stash, StashFile } from './stashes';
import { readStashes, readStashFiles, requireStashIdentity } from './stashes';
import {
  GitRequiresSourceControl,
  requireNoGitOperation,
} from './working-tree-state';

type Reader = Pick<GitCli, 'run'>;

type Writer = Pick<GitCli, 'run' | 'runBytes' | 'runWithInput'>;

async function currentStash(
  cli: Reader,
  id: string,
  sha: string,
): Promise<Stash> {
  requireStashIdentity(sha);
  const stash = (await readStashes(cli, id)).find((item) => item.sha === sha);

  if (!stash)
    throw new Error(
      'The selected stash is unavailable or disappeared. Refresh and select it again.',
    );

  return stash;
}

async function requireReadyForRestore(cli: Reader, id: string): Promise<void> {
  await requireNoGitOperation(cli, id, 'applying stash');
  if (
    (await cli.run(id, ['diff', '--name-only', '--diff-filter=U', '-z'])).length
  )
    throw new GitRequiresSourceControl(
      'Resolve conflicts in Source Control before applying stash.',
    );
}

export async function applyStash(
  cli: Reader,
  id: string,
  sha: string,
): Promise<void> {
  await currentStash(cli, id, sha);
  await requireReadyForRestore(cli, id);
  await cli.run(id, ['stash', 'apply', sha]);
}

export async function deleteStash(
  cli: Reader,
  id: string,
  sha: string,
): Promise<void> {
  const stash = await currentStash(cli, id, sha);
  const actual = (
    await cli.run(id, ['rev-parse', '--verify', stash.selector])
  ).trim();

  if (actual !== sha)
    throw new Error('The selected stash changed. Refresh and select it again.');
  await deleteStashEntry(cli, id, sha);
}

function sameFile(left: StashFile, right: StashFile): boolean {
  return (
    left.path === right.path &&
    left.originalPath === right.originalPath &&
    left.status === right.status &&
    left.snapshot === right.snapshot &&
    left.oldRef === right.oldRef &&
    left.newRef === right.newRef &&
    left.deleted === right.deleted
  );
}

export async function restoreStashFiles(
  cli: Writer,
  id: string,
  sha: string,
  files: readonly StashFile[],
): Promise<void> {
  const stash = await currentStash(cli, id, sha);

  if (!files.length) throw new Error('Select saved files to apply.');
  await requireReadyForRestore(cli, id);
  const available = await readStashFiles(cli, id, stash);
  const paths = new Set<string>();

  for (const file of files) {
    if (!available.some((item) => sameFile(item, file)))
      throw new Error(
        'The selected saved file changed. Refresh and select it again.',
      );
    for (const path of new Set([file.path, file.originalPath])) {
      if (paths.has(path))
        throw new Error(
          'Select only one saved snapshot version for each file.',
        );
      paths.add(path);
    }
  }

  const emptyTree = files.some((file) => file.oldRef === null)
    ? (
        await cli.runWithInput(id, ['hash-object', '-t', 'tree', '--stdin'], '')
      ).trim()
    : null;

  if (emptyTree !== null) requireStashIdentity(emptyTree);
  const patches: Buffer[] = [];

  for (const file of files) {
    const oldRef = file.oldRef ?? emptyTree;

    if (!oldRef) throw new Error('The saved file has no comparison tree.');
    patches.push(
      await cli.runBytes(id, [
        '--literal-pathspecs',
        '-c',
        'core.quotePath=true',
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-relative',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '-M',
        oldRef,
        file.newRef,
        '--',
        ...new Set([file.originalPath, file.path]),
      ]),
    );
  }

  const patch = Buffer.concat(patches);

  if (!patch.length) throw new Error('The selected saved changes are empty.');
  await currentStash(cli, id, sha);
  await requireReadyForRestore(cli, id);
  await cli.runWithInput(
    id,
    ['apply', '--check', '--whitespace=nowarn', '-'],
    patch,
  );
  await cli.runWithInput(id, ['apply', '--whitespace=nowarn', '-'], patch);
}
