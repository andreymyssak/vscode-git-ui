import { lstat, opendir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';

import { hasErrorCode } from '../../shared/validation';

const filenameIdentity = (path: string) => {
  const normalized = normalize(path);

  // macOS APFS/HFS+ names can be canonically equivalent without matching bytes.
  return process.platform === 'darwin'
    ? normalized.normalize('NFD')
    : normalized;
};

const varyCase = (name: string) =>
  name.replace(/[a-z]/i, (letter) =>
    letter === letter.toLowerCase()
      ? letter.toUpperCase()
      : letter.toLowerCase(),
  );

/** Infer case handling from existing entries without creating files or trusting Git config. */
async function directoryIgnoresCase(directory: string): Promise<boolean> {
  const current = await lstat(directory);
  const parent = dirname(directory);
  const parentInfo = await lstat(parent);
  const sameEntry = async (path: string) => {
    const original = await lstat(path);
    const alternate = join(dirname(path), varyCase(basename(path)));

    try {
      const candidate = await lstat(alternate);

      return (
        !candidate.isSymbolicLink() &&
        candidate.dev === original.dev &&
        candidate.ino === original.ino
      );
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;

      return false;
    }
  };

  if (
    parent !== directory &&
    parentInfo.dev === current.dev &&
    varyCase(basename(directory)) !== basename(directory)
  )
    return sameEntry(directory);
  for await (const entry of await opendir(directory)) {
    if (entry.isSymbolicLink() || varyCase(entry.name) === entry.name) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);

    if (info.dev !== current.dev || (info.isFile() && info.nlink > 1)) continue;

    return sameEntry(path);
  }

  if (parent !== directory && parentInfo.dev === current.dev)
    return directoryIgnoresCase(parent);
  throw new Error('Cannot verify unsaved file names on this filesystem.');
}

export function createWorktreeIdentityResolver() {
  const caseRules = new Map<string, Promise<boolean>>();

  return async (path: string) => {
    let ancestor = normalize(path);
    const missing: string[] = [];
    let links = 0;
    let resolved: string;
    let existing: string;

    for (;;) {
      try {
        existing = await realpath(ancestor);
        resolved = join(existing, ...missing);
        break;
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTDIR'))
          throw error;
        let link: string | null;

        try {
          link = await readlink(ancestor);
        } catch (linkError) {
          if (
            !hasErrorCode(linkError, 'ENOENT') &&
            !hasErrorCode(linkError, 'ENOTDIR') &&
            !hasErrorCode(linkError, 'EINVAL')
          )
            throw linkError;
          link = null;
        }

        if (link !== null) {
          if (++links > 40)
            throw new Error(
              'Too many folder aliases to verify unsaved edits.',
              { cause: error },
            );
          ancestor = resolve(await realpath(dirname(ancestor)), link);
          continue;
        }

        const parent = dirname(ancestor);

        if (parent === ancestor) throw error;
        missing.unshift(basename(ancestor));
        ancestor = parent;
      }
    }

    const directory = (await lstat(existing)).isDirectory()
      ? existing
      : dirname(existing);
    let ignoresCase = caseRules.get(directory);

    if (!ignoresCase) {
      ignoresCase = directoryIgnoresCase(directory);
      caseRules.set(directory, ignoresCase);
    }

    if (await ignoresCase) return filenameIdentity(resolved.toLowerCase());

    return filenameIdentity(resolved);
  };
}
