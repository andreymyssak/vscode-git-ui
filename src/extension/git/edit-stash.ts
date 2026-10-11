import type { GitCli } from './cli';
import { deleteStashEntry, replaceStashEntry } from './delete-stash';
import { readObjectParents } from './parents';
import type { StashFile } from './stashes';
import { readStashes, readStashFiles, requireStashIdentity } from './stashes';

async function selectedStash(cli: GitCli, id: string, sha: string) {
  requireStashIdentity(sha);
  const stash = (await readStashes(cli, id)).find((item) => item.sha === sha);

  if (!stash)
    throw new Error(
      'The selected stash disappeared. Refresh and select it again.',
    );

  return stash;
}

async function rewriteCommit(options: {
  cli: GitCli;
  id: string;
  sha: string;
  tree: string;
  parents: readonly string[];
  message: Buffer | string;
}): Promise<string> {
  const { cli, id, sha, tree, parents, message } = options;
  const original = await cli.runBytes(id, ['cat-file', 'commit', sha]);
  const split = original.indexOf('\n\n');

  if (split < 0) throw new Error('The saved commit has an invalid header.');
  const lines = original.subarray(0, split).toString('latin1').split('\n');

  if (
    lines.some(
      (line) => line.startsWith('gpgsig') || line.startsWith('mergetag '),
    )
  )
    throw new Error('Signed stash commits cannot be edited here.');
  requireStashIdentity(tree);
  for (const parent of parents) requireStashIdentity(parent);
  const metadata = lines.filter(
    (line) =>
      !line.startsWith('tree ') &&
      !line.startsWith('parent ') &&
      !(typeof message === 'string' && line.startsWith('encoding ')),
  );
  const header = [
    `tree ${tree}`,
    ...parents.map((parent) => `parent ${parent}`),
    ...metadata,
  ].join('\n');
  const object = Buffer.concat([
    Buffer.from(`${header}\n\n`, 'latin1'),
    typeof message === 'string' ? Buffer.from(message) : message,
  ]);
  const result = (
    await cli.runWithInput(
      id,
      ['hash-object', '-w', '-t', 'commit', '--stdin'],
      object,
    )
  ).trim();

  requireStashIdentity(result);

  return result;
}

export async function renameStash(
  cli: GitCli,
  id: string,
  sha: string,
  name: string,
): Promise<string> {
  if (!name.trim() || /[\r\n\0]/.test(name))
    throw new Error('Enter a stash name on one line.');
  await selectedStash(cli, id, sha);
  const tree = (await cli.run(id, ['rev-parse', `${sha}^{tree}`])).trim();
  const parents = await readObjectParents(cli, id, sha);
  const next = await rewriteCommit({
    cli,
    id,
    sha,
    tree,
    parents,
    message: `${name.trim()}\n`,
  });

  await replaceStashEntry(cli, id, sha, { sha: next, message: name.trim() });

  return next;
}

async function retainedTree(
  cli: GitCli,
  id: string,
  ref: string,
  base: string | null,
  paths: ReadonlySet<string>,
): Promise<string> {
  const current = await treeEntries(cli, id, ref);
  const original = base === null ? [] : await treeEntries(cli, id, base);
  const retained = original.filter((entry) => paths.has(entry.path));

  requireNoDirectoryConflict(original, current, paths);

  return cli.withTemporaryIndex(id, async (index) => {
    await index.run(['read-tree', ref]);
    const zero = '0'.repeat(ref.length);

    await index.run(
      ['update-index', '-z', '--index-info'],
      [...paths].map((path) => `0 ${zero}\t${path}\0`).join('') +
        retained
          .map((entry) => `${entry.mode} ${entry.object}\t${entry.path}\0`)
          .join(''),
    );

    return (await index.run(['write-tree'])).trim();
  });
}

function requireNoDirectoryConflict(
  original: readonly { path: string }[],
  current: readonly { path: string }[],
  paths: ReadonlySet<string>,
): void {
  if (
    original
      .filter((entry) => paths.has(entry.path))
      .some((entry) =>
        current.some(
          (saved) =>
            !paths.has(saved.path) &&
            (saved.path.startsWith(`${entry.path}/`) ||
              entry.path.startsWith(`${saved.path}/`)),
        ),
      )
  )
    throw new Error(
      'Deleting these saved files would replace an unselected file or directory. Select the related paths together.',
    );
}

async function treeEntries(cli: GitCli, id: string, ref: string) {
  const bytes = await cli.runBytes(id, ['ls-tree', '-r', '-z', ref]);
  const text = bytes.toString('utf8');

  if (!Buffer.from(text).equals(bytes))
    throw new Error(
      'This stash contains a filename that cannot be represented safely in the view. Delete its files with Git.',
    );

  return text
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, , object] = entry.slice(0, tab).split(' ');

      if (tab < 0 || !mode || !object)
        throw new Error('The saved tree has an invalid entry.');

      return { mode, object, path: entry.slice(tab + 1) };
    });
}

async function replaceTree(
  cli: GitCli,
  id: string,
  sha: string,
  tree: string,
  parents: readonly string[],
): Promise<string> {
  const original = await cli.runBytes(id, ['cat-file', 'commit', sha]);
  const split = original.indexOf('\n\n');

  if (split < 0) throw new Error('The saved commit has an invalid header.');

  return rewriteCommit({
    cli,
    id,
    sha,
    tree,
    parents,
    message: original.subarray(split + 2),
  });
}

/** Removing a file removes its working, index and untracked versions together. */
export async function deleteStashFiles(
  cli: GitCli,
  id: string,
  sha: string,
  files: readonly StashFile[],
): Promise<string | null> {
  const stash = await selectedStash(cli, id, sha);
  const [base, index, untracked] = await readObjectParents(cli, id, sha);

  if (!base || !index)
    throw new Error('The stash has an invalid parent structure.');
  // Validate the names before matching the view's decoded selection, even for a final-file deletion.
  const original = await treeEntries(cli, id, base);
  const working = await treeEntries(cli, id, sha);

  await treeEntries(cli, id, index);
  const extra = untracked ? await treeEntries(cli, id, untracked) : [];
  const available = await readStashFiles(cli, id, stash);

  if (!files.length) throw new Error('Select saved files to delete.');
  for (const file of files)
    if (
      !available.some((item) => JSON.stringify(item) === JSON.stringify(file))
    )
      throw new Error(
        'The selected saved file changed. Refresh and select it again.',
      );
  const paths = new Set(
    files.flatMap((file) => [file.path, file.originalPath]),
  );

  // A rename may be represented in more than one snapshot; keep its endpoints together.
  let previousSize = -1;

  while (paths.size !== previousSize) {
    previousSize = paths.size;
    for (const file of available)
      if (paths.has(file.path) || paths.has(file.originalPath)) {
        paths.add(file.path);
        paths.add(file.originalPath);
      }
  }

  if (available.every((file) => paths.has(file.path))) {
    await deleteStashEntry(cli, id, sha);

    return null;
  }

  requireNoDirectoryConflict(original, [...working, ...extra], paths);
  const indexTree = await retainedTree(cli, id, index, base, paths);
  const nextIndex = await replaceTree(
    cli,
    id,
    index,
    indexTree,
    await readObjectParents(cli, id, index),
  );
  const parents = [base, nextIndex];

  if (untracked) {
    const tree = await retainedTree(cli, id, untracked, null, paths);

    if (
      (await cli.run(id, ['ls-tree', '-r', '--name-only', '-z', tree])).length
    )
      parents.push(
        await replaceTree(
          cli,
          id,
          untracked,
          tree,
          await readObjectParents(cli, id, untracked),
        ),
      );
  }

  const tree = await retainedTree(cli, id, sha, base, paths);
  const next = await replaceTree(cli, id, sha, tree, parents);

  await replaceStashEntry(cli, id, sha, { sha: next, message: stash.message });

  return next;
}
