import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { GitCli } from '../cli';
import { readStashes, requireStashIdentity } from './stashes';

type Reader = Pick<GitCli, 'run'>;

interface FileSnapshot {
  path: string;
  info: Stats;
  bytes: Buffer;
}

interface OwnedLock {
  path: string;
  file: FileHandle;
  info: Stats;
}

interface ReflogEntry {
  sha: string;
  line: string;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function optionalInfo(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function unsupported(detail: string): Error {
  return new Error(
    `${detail} Manage this stash with Git after reviewing its current stash list.`,
  );
}

function gitPath(output: string): string {
  const path = output.endsWith('\n') ? output.slice(0, -1) : output;

  if (!path || path.includes('\0') || !isAbsolute(path))
    throw unsupported('Git returned an invalid repository path.');

  return path;
}

async function commonDirectory(cli: Reader, id: string): Promise<string> {
  return await realpath(
    gitPath(
      await cli.run(id, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]),
    ),
  );
}

async function requireDirectories(common: string): Promise<void> {
  for (const path of [
    common,
    join(common, 'refs'),
    join(common, 'logs'),
    join(common, 'logs', 'refs'),
  ]) {
    const info = await lstat(path);

    if (!info.isDirectory() || info.isSymbolicLink())
      throw unsupported(
        'Stash storage contains an unsupported directory or symbolic link.',
      );
  }
}

async function snapshot(path: string): Promise<FileSnapshot> {
  const info = await lstat(path);

  if (!info.isFile() || info.isSymbolicLink())
    throw unsupported(
      'Stash storage contains an unsupported file or symbolic link.',
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const opened = await file.stat();

    if (!opened.isFile() || !sameIdentity(info, opened))
      throw new Error(
        'Stash storage changed. Refresh and select the stash again.',
      );

    return { path, info: opened, bytes: await file.readFile() };
  } finally {
    await file.close();
  }
}

async function acquireLock(path: string): Promise<OwnedLock> {
  let file: FileHandle;

  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    throw new Error(
      'Stash editing could not acquire a Git lock. Finish other Git operations and try again; existing locks were preserved.',
      { cause: error },
    );
  }

  let openedInfo: Stats | null = null;

  try {
    const opened = await file.stat();

    openedInfo = opened;
    const info = await lstat(path);

    if (!info.isFile() || !sameIdentity(info, opened))
      throw new Error(
        'A stash-editing lock changed while it was being acquired.',
      );

    return { path, file, info: opened };
  } catch (error) {
    try {
      if (openedInfo) await releaseLock({ path, file, info: openedInfo });
      else await file.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Stash editing could not acquire or clean up its Git lock. Review Git storage before trying again.',
        { cause: cleanup },
      );
    }

    if (!openedInfo)
      throw new Error(
        'Stash editing could not verify its newly created Git lock. Its file handle was closed and the lock was preserved; review Git storage before trying again.',
        { cause: error },
      );
    throw error;
  }
}

async function requireOwnLock(lock: OwnedLock): Promise<void> {
  const info = await optionalInfo(lock.path);

  if (!info?.isFile() || !sameIdentity(lock.info, info))
    throw new Error(
      'A stash-editing lock changed. Review Git storage before trying again.',
    );
}

async function releaseLock(lock: OwnedLock): Promise<void> {
  await lock.file.close();
  const info = await optionalInfo(lock.path);

  if (!info) return;
  if (!info.isFile() || !sameIdentity(lock.info, info))
    throw new Error(
      'A stash-editing lock was replaced; the other process lock was preserved.',
    );
  await unlink(lock.path);
}

async function requireUnchanged(file: FileSnapshot): Promise<void> {
  const current = await snapshot(file.path);

  if (
    !sameIdentity(file.info, current.info) ||
    !file.bytes.equals(current.bytes)
  )
    throw new Error(
      'Stash storage changed. Refresh and select the stash again.',
    );
}

function reflogEntries(bytes: Buffer, width: number): ReflogEntry[] {
  const text = bytes.toString('latin1');

  if (!text.endsWith('\n') || text.includes('\0'))
    throw unsupported('The stash reflog has an unsupported format.');
  const lines = text.slice(0, -1).split('\n');
  const pattern = new RegExp(
    `^[a-f0-9]{${width}} ([a-f0-9]{${width}}) [^<>\\r\\n]+ <[^<>\\r\\n]*> [1-9][0-9]* [+-][0-9]{4}\\t[^\\r\\n]*$`,
    'i',
  );

  return lines.map((line) => {
    const match = pattern.exec(line);
    const sha = match?.[1];

    if (!sha) throw unsupported('The stash reflog has an unsupported format.');

    return { sha: sha.toLowerCase(), line };
  });
}

function rewrittenReflog(
  entries: readonly ReflogEntry[],
  width: number,
): Buffer {
  let previous = '0'.repeat(width);
  const lines = entries.map((entry) => {
    const line = `${previous}${entry.line.slice(width)}\n`;

    previous = entry.sha;

    return line;
  });

  return Buffer.from(lines.join(''), 'latin1');
}

async function requireNoTransactionHook(
  cli: Reader,
  id: string,
): Promise<void> {
  const directory = gitPath(
    await cli.run(id, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'hooks',
    ]),
  );
  const info = await stat(join(directory, 'reference-transaction')).catch(
    (error: unknown) => {
      if (
        missing(error) ||
        (error instanceof Error && 'code' in error && error.code === 'ENOTDIR')
      )
        return null;
      throw error;
    },
  );

  if (
    info?.isFile() &&
    (process.platform === 'win32' || (info.mode & 0o111) !== 0)
  )
    throw unsupported(
      'The final stash cannot be deleted here because this repository has an executable reference-transaction hook.',
    );
}

async function requireNoPackedStash(
  path: string,
): Promise<FileSnapshot | null> {
  if (!(await optionalInfo(path))) return null;
  const packed = await snapshot(path);

  if (
    packed.bytes
      .toString('latin1')
      .split('\n')
      .some((line) => /^\S+ refs\/stash$/.test(line))
  )
    throw unsupported('Packed stash refs are not supported for stash editing.');

  return packed;
}

type Edit =
  { kind: 'delete' } | { kind: 'replace'; sha: string; message: string };

export async function deleteStashEntry(
  cli: Reader,
  id: string,
  sha: string,
): Promise<void> {
  await editStashEntry(cli, id, sha, { kind: 'delete' });
}

export async function replaceStashEntry(
  cli: Reader,
  id: string,
  sha: string,
  replacement: { sha: string; message: string },
): Promise<void> {
  requireStashIdentity(replacement.sha);
  if (replacement.sha.length !== sha.length)
    throw new Error(
      'The replacement stash uses a different Git object format.',
    );
  if (!replacement.message.trim() || /[\r\n\0]/.test(replacement.message))
    throw new Error('Enter a stash name on one line.');
  await editStashEntry(cli, id, sha, { kind: 'replace', ...replacement });
}

/** Git's files backend protects reflog rewrites with the ref lock, then installs the log before its tip. */
async function editStashEntry(
  cli: Reader,
  id: string,
  sha: string,
  edit: Edit,
): Promise<void> {
  requireStashIdentity(sha);
  const format = (await cli.run(id, ['rev-parse', '--show-ref-format'])).trim();

  if (format !== 'files')
    throw unsupported(
      'Stash editing requires Git with ordinary files-based refs.',
    );
  const common = await commonDirectory(cli, id);

  await requireDirectories(common);
  const commonInfo = await lstat(common);
  const refPath = join(common, 'refs', 'stash');
  const logPath = join(common, 'logs', 'refs', 'stash');
  const packedPath = join(common, 'packed-refs');
  const refLock = await acquireLock(`${refPath}.lock`);
  const owned = [refLock];
  const installed = new Set<OwnedLock>();
  let logInstalled = false;
  let failure: { error: unknown } | null = null;

  try {
    // Packing refs must not create a hidden stash tip while its loose ref is being removed.
    const packedLock = await acquireLock(`${packedPath}.lock`);

    owned.push(packedLock);
    await requireDirectories(common);
    const packed = await requireNoPackedStash(packedPath);
    const refInfo = await optionalInfo(refPath);

    if (!refInfo) throw unsupported('The stash ref is unavailable or packed.');
    const ref = await snapshot(refPath);
    const current = ref.bytes.toString('latin1');

    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/i.test(current))
      throw unsupported(
        'Symbolic or malformed stash refs are not supported for stash editing.',
      );
    const tip = current.slice(0, -1).toLowerCase();
    const log = await snapshot(logPath);
    const entries = reflogEntries(log.bytes, tip.length);

    if (entries.at(-1)?.sha !== tip)
      throw new Error(
        'The stash ref and reflog differ. Review Git storage before editing a stash.',
      );
    const visible = await readStashes(cli, id);
    const ordered = [...entries].reverse();

    if (
      visible.length !== ordered.length ||
      visible.some((stash, index) => stash.sha !== ordered[index]?.sha)
    )
      throw unsupported(
        'The stash reflog contains entries Git cannot read safely.',
      );
    const matches = entries.filter((entry) => entry.sha === sha.toLowerCase());

    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? 'This stash identity occurs more than once. Delete the intended entry with Git after reviewing its stash list.'
          : 'The selected stash disappeared. Refresh and select it again.',
      );
    if (
      edit.kind === 'replace' &&
      entries.some(
        (entry) => entry !== matches[0] && entry.sha === edit.sha.toLowerCase(),
      )
    )
      throw new Error(
        'Editing this stash would create an identical saved entry. Choose a different name or review the stash list with Git.',
      );
    const remaining = entries.flatMap((entry) => {
      if (entry !== matches[0]) return [entry];
      if (edit.kind === 'delete') return [];
      const tab = entry.line.indexOf('\t');
      const line = `${entry.line.slice(0, tip.length + 1)}${edit.sha}${entry.line.slice(tip.length * 2 + 1, tab + 1)}${Buffer.from(edit.message, 'utf8').toString('latin1')}`;

      return [{ sha: edit.sha, line }];
    });
    const nextTip = remaining.at(-1)?.sha;

    if (!nextTip) await requireNoTransactionHook(cli, id);
    const logLock = await acquireLock(`${logPath}.lock`);

    owned.push(logLock);
    await logLock.file.chmod(log.info.mode & 0o777);
    await logLock.file.writeFile(rewrittenReflog(remaining, tip.length));
    await logLock.file.sync();
    if (nextTip && nextTip !== tip) {
      await refLock.file.chmod(ref.info.mode & 0o777);
      await refLock.file.writeFile(`${nextTip}\n`);
      await refLock.file.sync();
    }

    // Revalidate Git routing and source bytes before the first irreversible installation.
    if (
      (await commonDirectory(cli, id)) !== common ||
      !sameIdentity(commonInfo, await lstat(common))
    )
      throw new Error(
        'The repository path changed. Refresh before editing the stash.',
      );
    await requireDirectories(common);
    await requireUnchanged(ref);
    await requireUnchanged(log);
    if (packed) await requireUnchanged(packed);
    else if (await optionalInfo(packedPath))
      throw new Error('Packed refs changed. Refresh before editing the stash.');
    if (!nextTip) await requireNoTransactionHook(cli, id);
    for (const lock of owned) await requireOwnLock(lock);
    await logLock.file.close();
    await refLock.file.close();
    await rename(logLock.path, logPath);
    installed.add(logLock);
    logInstalled = true;
    if (!nextTip) {
      await unlink(refPath);
      await unlink(logPath);
    } else if (nextTip !== tip) {
      await rename(refLock.path, refPath);
      installed.add(refLock);
    }
  } catch (error) {
    failure = {
      error: logInstalled
        ? new Error(
            'Stash editing stopped after updating its reflog. Review Git storage before doing anything else; the operation was not retried.',
            { cause: error },
          )
        : error,
    };
  }

  const cleanupErrors: unknown[] = [];

  for (const lock of [...owned].reverse()) {
    try {
      if (installed.has(lock)) await lock.file.close();
      else await releaseLock(lock);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
      `${failure?.error instanceof Error ? `${failure.error.message} ` : ''}Git lock cleanup also failed. Review Git storage before trying again.`,
    );
  if (failure) throw failure.error;
}
