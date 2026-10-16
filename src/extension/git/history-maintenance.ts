import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { GitApiAccess } from './api';
import { type GitCapabilityCli, readGitCapabilities } from './capabilities';
import type { GitCli } from './cli';

const throttleMs = 5 * 60 * 1000;
// Separate from repositoryOperations: foreground Git writes never wait for this cache.
const commonTasks = new Map<
  string,
  { running: boolean; attemptedAt: number }
>();

type RepositoryRoot = {
  rootUri: Pick<ReturnType<GitApiAccess['repository']>['rootUri'], 'fsPath'>;
};

interface HistoryMaintenanceOptions {
  access: { repository(id: string): RepositoryRoot };
  cli: GitCapabilityCli & Pick<GitCli, 'stream'>;
  isEnabled: (id: string) => boolean;
  isTrusted: () => boolean;
  now?: () => number;
  schedule?: (task: () => Promise<void>) => { dispose(): void };
}

interface Task {
  owner: AbortController;
  scheduled: { dispose(): void } | undefined;
}

function schedule(task: () => Promise<void>) {
  const timer = setTimeout(() => {
    void task();
  }, 1000);

  timer.unref();

  return { dispose: () => clearTimeout(timer) };
}

/** Optional commit-graph cache writes own their process, cancellation and common-dir lane. */
export function createHistoryMaintenance({
  access,
  cli,
  isEnabled,
  isTrusted,
  now = Date.now,
  schedule: enqueue = schedule,
}: HistoryMaintenanceOptions) {
  const tasks = new Map<string, Task>();
  let disposed = false;
  const invalidate = (id: string) => {
    const task = tasks.get(id);

    tasks.delete(id);
    task?.scheduled?.dispose();
    task?.owner.abort();
  };

  const maintain = async (id: string, root: string, task: Task) => {
    const signal = task.owner.signal;
    const current = () => {
      signal.throwIfAborted();
      if (
        disposed ||
        tasks.get(id) !== task ||
        !isTrusted() ||
        !isEnabled(id) ||
        access.repository(id).rootUri.fsPath !== root
      )
        throw new Error('History cache maintenance is no longer available.');
    };

    const read = (args: readonly string[]) =>
      cli.run(id, args, signal, current);
    const configuration = async (args: readonly string[]) => {
      try {
        return await read(['config', ...args]);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 1)
          return null;
        throw error;
      }
    };

    current();
    const directory = await realpath(
      resolve(
        root,
        (await read(['rev-parse', '--git-common-dir'])).replace(/\r?\n$/, ''),
      ),
    );
    const key =
      process.platform === 'win32' ? directory.toLowerCase() : directory;
    const time = now();

    for (const [path, state] of commonTasks) {
      if (!state.running && time - state.attemptedAt >= throttleMs)
        commonTasks.delete(path);
    }

    const previous = commonTasks.get(key);

    if (
      previous?.running ||
      (previous && time - previous.attemptedAt < throttleMs)
    )
      return;
    current();
    const state = { running: true, attemptedAt: time };

    commonTasks.set(key, state);
    try {
      const installed = await readGitCapabilities(cli, id, signal);

      current();
      if (!installed.commitGraph) return;
      const args = ['commit-graph', 'write', '--reachable', '--split'];

      // Bloom filters appeared in 2.27; existing graphs/config can enable scans implicitly.
      if (installed.commitGraphNoChangedPaths) args.push('--no-changed-paths');
      await cli.stream(
        id,
        args,
        () => true,
        signal,
        undefined,
        async () => {
          current();
          if (
            (
              await configuration(['--bool', '--get', 'core.commitGraph'])
            )?.trim() === 'false'
          )
            throw new Error('Commit graphs are disabled.');
          if (
            (await read(['rev-parse', '--is-shallow-repository'])).trim() !==
            'false'
          )
            throw new Error('Shallow history is not eligible.');
          if (
            (await configuration(['--get', 'extensions.partialClone'])) !== null
          )
            throw new Error('Partial history is not eligible.');
          const promisors = await configuration([
            '--bool',
            '--get-regexp',
            '^remote\\..*\\.promisor$',
          ]);

          if (promisors?.split(/\r?\n/).some((line) => / true$/.test(line)))
            throw new Error('Promisor history is not eligible.');
          if (
            (await readdir(join(directory, 'objects', 'pack'))).some((name) =>
              name.endsWith('.promisor'),
            )
          )
            throw new Error('Promisor objects are not eligible.');
          current();
        },
      );
    } finally {
      // Aborting never releases this lane before its owned Git invocation settles.
      state.running = false;
    }
  };

  return {
    request(id: string): void {
      if (disposed || tasks.has(id)) return;
      try {
        if (!isTrusted() || !isEnabled(id)) return;
        const root = access.repository(id).rootUri.fsPath;
        const task: Task = {
          owner: new AbortController(),
          scheduled: undefined,
        };

        tasks.set(id, task);
        task.scheduled = enqueue(async () => {
          try {
            await maintain(id, root, task);
          } catch {
            // Cache optimization is best effort, including unsupported/locked/read-only Git.
          } finally {
            if (tasks.get(id) === task) tasks.delete(id);
          }
        });
      } catch {
        invalidate(id);
      }
    },
    invalidate,
    dispose(): void {
      disposed = true;
      for (const id of tasks.keys()) invalidate(id);
    },
  };
}
