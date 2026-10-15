import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';

import { SQUASH_RECOVERY_OWNER } from '../../shared/extension-identity';
import { hasErrorCode, isRecord } from '../../shared/validation';
import { backgroundRead } from './background-read';
import type { GitCli } from './cli';
import type { SquashSnapshot } from './squash';
import { validateSquashMessage } from './squash';
import type { SquashEditorInput } from './squash-editor';

// Versions through 0.1.2 wrote this marker. Read their unfinished operations.
const LEGACY_RECOVERY_OWNER = 'git-native-ui-squash';

interface OwnedRecord {
  owner: string;
  repositoryId: string;
  root: string;
  statePaths: [string, string];
  directory: string;
  observedRebase: boolean;
}

const canonical = (path: string) =>
  process.platform === 'win32'
    ? normalize(path).toLowerCase()
    : normalize(path);
const pathStatus = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
};

function isOwnedRecord(value: unknown): value is OwnedRecord {
  if (!isRecord(value)) return false;
  const record = value;

  return (
    typeof record.observedRebase === 'boolean' &&
    Object.keys(record).sort().join(',') ===
      'directory,observedRebase,owner,repositoryId,root,statePaths' &&
    (record.owner === SQUASH_RECOVERY_OWNER ||
      record.owner === LEGACY_RECOVERY_OWNER) &&
    typeof record.repositoryId === 'string' &&
    record.repositoryId.length > 0 &&
    typeof record.root === 'string' &&
    isAbsolute(record.root) &&
    typeof record.directory === 'string' &&
    isAbsolute(record.directory) &&
    Array.isArray(record.statePaths) &&
    record.statePaths.length === 2 &&
    record.statePaths.every(
      (path) => typeof path === 'string' && isAbsolute(path),
    )
  );
}

export class SquashRecovery {
  private readonly preparing = new Set<string>();
  constructor(
    private readonly storageDirectory: string,
    private readonly cli: Pick<GitCli, 'run'>,
  ) {}

  private identity(id: string) {
    return backgroundRead(async (signal) => {
      const topLevel = await this.cli.run(
        id,
        ['rev-parse', '--show-toplevel'],
        signal,
      );

      signal.throwIfAborted();
      const root = await realpath(topLevel.replace(/\r?\n$/, ''));

      // realpath cannot be interrupted, so a late completion must not start Git.
      signal.throwIfAborted();
      const statePath = async (state: string) => {
        const path = (
          await this.cli.run(
            id,
            ['rev-parse', '--path-format=absolute', '--git-path', state],
            signal,
          )
        ).replace(/\r?\n$/, '');

        if (!isAbsolute(path))
          throw new Error('Git returned an invalid recovery state path.');

        return resolve(path);
      };

      const statePaths = await Promise.all([
        statePath('rebase-merge'),
        statePath('rebase-apply'),
      ]);

      return { root, statePaths };
    });
  }

  async create(
    id: string,
    snapshot: Pick<
      SquashSnapshot,
      'oldestToNewest' | 'oldestParentSha' | 'replayShas'
    >,
    message: string,
    operation: 'squash' | 'reword' = 'squash',
  ): Promise<{ directory: string; inputPath: string }> {
    validateSquashMessage(message);
    const identity = await this.identity(id);

    await mkdir(this.storageDirectory, { recursive: true, mode: 0o700 });
    const storage = await realpath(this.storageDirectory);
    const withinRoot = relative(canonical(identity.root), canonical(storage));

    if (
      !withinRoot ||
      (!withinRoot.startsWith('..') && !isAbsolute(withinRoot))
    )
      throw new Error(
        'Squash recovery storage must be outside the working repository.',
      );

    const directory = await mkdtemp(join(storage, 'operation-'));

    this.preparing.add(directory);
    const inputPath = join(directory, 'input.json');
    const record: OwnedRecord = {
      owner: SQUASH_RECOVERY_OWNER,
      repositoryId: id,
      ...identity,
      directory,
      observedRebase: false,
    };

    try {
      const messagePath = join(directory, 'message.txt');

      await writeFile(messagePath, message, { mode: 0o600 });
      const baseTree = (
        await this.cli.run(id, [
          'rev-parse',
          '--verify',
          `${snapshot.oldestParentSha}^{tree}`,
        ])
      ).trim();
      // An unreferenced, empty-patch message carrier lets native Continue retain
      // the approved message without relying on the first child's editor env.
      // Signing remains enabled for the actual rewritten history.
      const messageCommitSha = (
        await this.cli.run(id, [
          '-c',
          'commit.gpgSign=false',
          'commit-tree',
          baseTree,
          '-p',
          snapshot.oldestParentSha,
          '-F',
          messagePath,
        ])
      ).trim();

      if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(messageCommitSha))
        throw new Error('Git returned an invalid message object identity.');
      const input: SquashEditorInput = {
        operation,
        messageCommitSha,
        replayShas: snapshot.replayShas,
        oldestToNewest: snapshot.oldestToNewest,
        message,
      };

      await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
      await writeFile(join(directory, 'record.json'), JSON.stringify(record), {
        mode: 0o600,
      });

      return { directory, inputPath };
    } catch (error) {
      this.preparing.delete(directory);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async record(directory: string): Promise<OwnedRecord | null> {
    const storage = await realpath(this.storageDirectory);
    const path = resolve(directory);

    if (
      canonical(dirname(path)) !== canonical(storage) ||
      !path.slice(dirname(path).length + 1).startsWith('operation-')
    )
      throw new Error(
        'Recovery cleanup requires an owned operation directory.',
      );
    try {
      const status = await lstat(path);

      if (!status.isDirectory() || status.isSymbolicLink()) return null;
      const recordPath = join(path, 'record.json');
      const metadata = await lstat(recordPath);

      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 64 * 1024
      )
        return null;
      const value: unknown = JSON.parse(await readFile(recordPath, 'utf8'));

      if (
        !isOwnedRecord(value) ||
        canonical(value.directory) !== canonical(path)
      )
        return null;

      return value;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT') || error instanceof SyntaxError)
        return null;
      throw error;
    }
  }

  private async observeRebase(record: OwnedRecord): Promise<void> {
    if (record.observedRebase) return;
    const temporary = join(record.directory, `record-${randomUUID()}.tmp`);

    try {
      await writeFile(
        temporary,
        JSON.stringify({ ...record, observedRebase: true }),
        { flag: 'wx', mode: 0o600 },
      );
      await rename(temporary, join(record.directory, 'record.json'));
    } catch (error) {
      // Another terminal owner may have removed the complete directory.
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async settle(id: string, directory: string): Promise<void> {
    const record = await this.record(directory);

    if (!record || record.repositoryId !== id) return;
    // Only the creator calls settle after its Git child has returned. A fresh
    // instance has no such knowledge while a pre-rebase hook is still running.
    const locallyCompleted = this.preparing.has(record.directory);

    this.preparing.delete(record.directory);
    let active: boolean;
    let observed: boolean;

    try {
      const current = await this.identity(id);

      if (
        canonical(current.root) !== canonical(record.root) ||
        current.statePaths.some(
          (path, index) =>
            canonical(path) !== canonical(record.statePaths[index]!),
        )
      )
        return;
      const states = await Promise.all(current.statePaths.map(pathStatus));

      active = states.some((status) => status !== null);
      observed = states.some(
        (status) =>
          status !== null && status.isDirectory() && !status.isSymbolicLink(),
      );
    } catch {
      // Closed or inaccessible repositories do not prove terminal Git state.
      return;
    }

    if (active) {
      if (observed) await this.observeRebase(record);

      return;
    }

    // Absence alone is ambiguous before Git creates its state directory. Once
    // that state was observed durably, absence proves native continue/abort ended.
    if (!locallyCompleted && !record.observedRebase) return;

    await rm(record.directory, { recursive: true, force: true });
  }

  async reconcile(): Promise<void> {
    if (!(await pathStatus(this.storageDirectory))) return;
    const storage = await realpath(this.storageDirectory);

    for (const entry of await readdir(storage, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('operation-'))
        continue;
      const directory = join(storage, entry.name);

      if (this.preparing.has(directory)) continue;
      const record = await this.record(directory);

      if (record) await this.settle(record.repositoryId, directory);
    }
  }
}
