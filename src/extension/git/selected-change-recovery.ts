import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { hasErrorCode, isRecord } from '../../shared/validation';
import type { GitCli } from './cli';

type Cli = Pick<GitCli, 'run'>;

export interface SelectedChangeRecovery {
  version: 1;
  token: string;
  root: string;
  kind: 'cherry-pick-files' | 'revert-files';
  head: string;
  branch: string;
  paths: string[];
}

export function safeRecoveryPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 8192 &&
    !isAbsolute(path) &&
    !path.includes('\0') &&
    !(process.platform === 'win32' && path.includes('\\')) &&
    path
      .split('/')
      .every(
        (part) =>
          Boolean(part) &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

function parse(value: unknown, root: string): SelectedChangeRecovery {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.root !== root ||
    typeof value.token !== 'string' ||
    !/^[a-f\d-]{36}$/i.test(value.token) ||
    (value.kind !== 'cherry-pick-files' && value.kind !== 'revert-files') ||
    typeof value.head !== 'string' ||
    !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value.head) ||
    typeof value.branch !== 'string' ||
    !value.branch.startsWith('refs/heads/') ||
    !Array.isArray(value.paths) ||
    !value.paths.length ||
    value.paths.length > 800 ||
    !value.paths.every(safeRecoveryPath) ||
    new Set(value.paths).size !== value.paths.length
  )
    throw new Error(
      'Cannot verify the selected-change recovery record. Review the repository before continuing.',
    );

  return {
    version: 1,
    root,
    token: value.token,
    kind: value.kind,
    head: value.head,
    branch: value.branch,
    paths: value.paths,
  };
}

async function location(cli: Cli, id: string) {
  return (
    await cli.run(id, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'git-ui-selected-changes.json',
    ])
  ).replace(/\r?\n$/, '');
}

export async function readSelectedChangeRecovery(
  cli: Cli,
  id: string,
  root: string,
) {
  const path = await location(cli, id);

  return readAtLocation(path, root);
}

async function readAtLocation(path: string, root: string) {
  try {
    const stat = await lstat(path);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
      throw new Error('Cannot verify the selected-change recovery record.');

    return parse(JSON.parse(await readFile(path, 'utf8')), root);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** Persist before native apply: a failed three-way patch has no Git abort metadata. */
export async function startSelectedChangeRecovery(
  cli: Cli,
  id: string,
  options: Omit<SelectedChangeRecovery, 'version' | 'token'>,
) {
  const record = parse(
    { ...options, version: 1, token: randomUUID() },
    options.root,
  );
  const path = await location(cli, id);
  const serialized = JSON.stringify(record);

  if (Buffer.byteLength(serialized) > 256 * 1024)
    throw new Error(
      'Select fewer files so their cancellation information can be saved before applying changes.',
    );
  const file = await open(path, 'wx', 0o600);

  try {
    await file.writeFile(serialized);
    await file.sync();
  } finally {
    await file.close();
  }

  // Pin the verified metadata location before native apply can outlive this repository session.
  return { record, clear: () => clearAtLocation(path, record) };
}

export async function clearSelectedChangeRecovery(
  cli: Cli,
  id: string,
  record: SelectedChangeRecovery,
) {
  await clearAtLocation(await location(cli, id), record);
}

async function clearAtLocation(path: string, record: SelectedChangeRecovery) {
  const current = await readAtLocation(path, record.root);

  if (current?.token === record.token) await unlink(path);
}
