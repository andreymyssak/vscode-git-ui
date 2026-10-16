import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, onTestFinished, test, vi } from 'vitest';

import type { GitCli } from '../../src/extension/git/cli';
import { createHistoryMaintenance } from '../../src/extension/git/history-maintenance';
import { repositoryOperations } from '../../src/extension/git/operation-queue';

function deferred() {
  let resolve: () => void = () => {};

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), 'git-ui-history-maintenance-'),
  );
  const common = join(directory, '.git');
  const tasks: { run: () => Promise<void>; cancelled: boolean }[] = [];
  const writes: {
    id: string;
    args: readonly string[];
    signal?: AbortSignal;
  }[] = [];
  const commands: string[][] = [];
  const config = new Map<string, string>();
  let enabled = true;
  let trusted = true;
  let available = true;
  let root = directory;
  let version = 'git version 2.47.1';
  let shallow = false;
  let now = 0;
  let beforeWrite: (() => void | Promise<void>) | undefined;
  let write: (() => Promise<void>) | undefined;

  await mkdir(join(common, 'objects', 'pack'), { recursive: true });
  const access = {
    repository() {
      if (!available) throw new Error('Repository closed');

      // Native Git may return a fresh wrapper for the same open repository.
      return { rootUri: { fsPath: root } };
    },
  };
  const cli: Pick<GitCli, 'run' | 'stream'> = {
    async run(id, args, signal, beforeExecute) {
      signal?.throwIfAborted();
      commands.push([...args]);
      await beforeExecute?.();
      if (args[0] === '--version') return version;
      if (args.includes('--git-common-dir')) return common + '\n';
      if (args.includes('--is-shallow-repository')) return `${shallow}\n`;
      if (args[0] === 'config') {
        const value = config.get(args.at(-1) ?? '');

        if (value === undefined)
          throw Object.assign(new Error('unset'), { code: 1 });

        return value;
      }

      throw new Error(`Unexpected read ${args.join(' ')}`);
    },
    async stream(id, args, _consume, signal, _input, beforeExecute) {
      signal?.throwIfAborted();
      commands.push([...args]);
      await beforeWrite?.();
      await beforeExecute?.();
      signal?.throwIfAborted();
      writes.push({ id, args, ...(signal ? { signal } : {}) });
      await write?.();
    },
  };
  const options = {
    access,
    cli,
    isEnabled: () => enabled,
    isTrusted: () => trusted,
    now: () => now,
    schedule(run: () => Promise<void>) {
      const task = { run, cancelled: false };

      tasks.push(task);

      return {
        dispose: () => {
          task.cancelled = true;
        },
      };
    },
  };
  const maintenance = createHistoryMaintenance(options);

  onTestFinished(async () => {
    maintenance.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    maintenance,
    options,
    writes,
    commands,
    common,
    config,
    async flush() {
      while (tasks.length) {
        const task = tasks.shift();

        if (task && !task.cancelled) await task.run();
      }
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
    setTrusted(value: boolean) {
      trusted = value;
    },
    setAvailable(value: boolean) {
      available = value;
    },
    setRoot(value: string) {
      root = value;
    },
    setVersion(value: string) {
      version = value;
    },
    setShallow(value: boolean) {
      shallow = value;
    },
    setTime(value: number) {
      now = value;
    },
    setBeforeWrite(value: typeof beforeWrite) {
      beforeWrite = value;
    },
    setWrite(value: typeof write) {
      write = value;
    },
  };
}

test('requests return before Git work and keep the interactive writer queue free', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();

  f.setWrite(async () => {
    entered.resolve();
    await release.promise;
  });
  onTestFinished(async () => {
    release.resolve();
  });
  expect(f.maintenance.request('one')).toBeUndefined();
  expect(f.commands).toHaveLength(0);
  const pending = f.flush();

  await entered.promise;
  expect(await repositoryOperations.run('one', async () => 'foreground')).toBe(
    'foreground',
  );
  expect(
    await repositoryOperations.run(
      `common:${f.common}`,
      async () => 'foreground',
    ),
  ).toBe('foreground');
  release.resolve();
  await pending;
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.args).toEqual([
    'commit-graph',
    'write',
    '--reachable',
    '--split',
    '--no-changed-paths',
  ]);
});

test.each(['setting', 'trust', 'closed'] as const)(
  'skips %s repositories before scheduling',
  async (reason) => {
    const f = await fixture();

    if (reason === 'setting') f.setEnabled(false);
    if (reason === 'trust') f.setTrusted(false);
    if (reason === 'closed') f.setAvailable(false);
    expect(() => f.maintenance.request('one')).not.toThrow();
    await f.flush();
    expect(f.commands).toHaveLength(0);
  },
);

test.each([
  'setting',
  'trust',
  'closed',
  'root',
  'git-config',
  'partial-clone',
  'invalidate',
  'dispose',
] as const)(
  'rechecks %s immediately before the subprocess can write',
  async (reason) => {
    const f = await fixture();

    f.setBeforeWrite(() => {
      if (reason === 'setting') f.setEnabled(false);
      if (reason === 'trust') f.setTrusted(false);
      if (reason === 'closed') f.setAvailable(false);
      if (reason === 'root') f.setRoot('/replaced');
      if (reason === 'git-config') f.config.set('core.commitGraph', 'false\n');
      if (reason === 'partial-clone')
        f.config.set('extensions.partialClone', 'origin\n');
      if (reason === 'invalidate') f.maintenance.invalidate('one');
      if (reason === 'dispose') f.maintenance.dispose();
    });
    f.maintenance.request('one');
    await f.flush();
    expect(f.writes).toHaveLength(0);
  },
);

test('explicitly disabled promisor remotes do not suppress local cache maintenance', async () => {
  const f = await fixture();

  f.config.set('^remote\\..*\\.promisor$', 'remote.origin.promisor false\n');
  f.maintenance.request('one');
  await f.flush();
  expect(f.writes).toHaveLength(1);
});

test('the default scheduler yields for a second and disposal prevents its delayed write', async () => {
  const f = await fixture();

  vi.useFakeTimers();
  const maintenance = createHistoryMaintenance({
    access: f.options.access,
    cli: f.options.cli,
    isEnabled: f.options.isEnabled,
    isTrusted: f.options.isTrusted,
  });

  onTestFinished(async () => {
    maintenance.dispose();
    vi.useRealTimers();
  });
  maintenance.request('one');
  await vi.advanceTimersByTimeAsync(999);
  expect(f.commands).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.commands[0]).toEqual(['rev-parse', '--git-common-dir']);
  maintenance.dispose();
  await vi.runAllTimersAsync();
  expect(f.writes).toHaveLength(0);
});

test.each([
  'git version 2.23.4',
  'git version 1.9.5',
  'git version 2.47.0-rc1',
  'git version 2.47.0 (custom vendor)',
  'unknown',
])('skips unsupported Git %s', async (version) => {
  const f = await fixture();

  f.setVersion(version);
  f.maintenance.request('one');
  await f.flush();
  expect(f.writes).toHaveLength(0);
});

test.each(['git version 2.24.0.windows.1', 'git version 2.26.3 (Apple Git-1)'])(
  'uses supported baseline flags on %s',
  async (version) => {
    const f = await fixture();

    f.setVersion(version);
    f.maintenance.request('one');
    await f.flush();
    expect(f.writes[0]?.args).toEqual([
      'commit-graph',
      'write',
      '--reachable',
      '--split',
    ]);
  },
);

test.each(['core', 'partial', 'promisor', 'shallow', 'pack'] as const)(
  'skips %s repositories without a cache write',
  async (reason) => {
    const f = await fixture();

    if (reason === 'core') f.config.set('core.commitGraph', 'false\n');
    if (reason === 'partial')
      f.config.set('extensions.partialClone', 'origin\n');
    if (reason === 'promisor')
      f.config.set('^remote\\..*\\.promisor$', 'remote.origin.promisor true\n');
    if (reason === 'shallow') f.setShallow(true);
    if (reason === 'pack')
      await writeFile(
        join(f.common, 'objects', 'pack', 'pack-one.promisor'),
        '',
      );
    f.maintenance.request('one');
    await f.flush();
    expect(f.writes).toHaveLength(0);
  },
);

test('single-flight and five-minute throttle cover linked worktrees and separate adapters', async () => {
  const f = await fixture();
  const other = createHistoryMaintenance(f.options);
  const entered = deferred();
  const release = deferred();

  onTestFinished(async () => {
    release.resolve();
    other.dispose();
  });
  f.setWrite(async () => {
    entered.resolve();
    await release.promise;
  });
  f.maintenance.request('one');
  f.maintenance.request('one');
  const pending = f.flush();

  await entered.promise;
  other.request('linked');
  await f.flush();
  expect(f.writes).toHaveLength(1);
  release.resolve();
  await pending;
  f.setTime(299_999);
  other.request('linked');
  await f.flush();
  expect(f.writes).toHaveLength(1);
  f.setTime(300_000);
  other.request('linked');
  await f.flush();
  expect(f.writes).toHaveLength(2);
});

test.each(['read-only', 'lock', 'unsupported'])(
  'detaches %s write failures and throttles repeated attempts',
  async (reason) => {
    const f = await fixture();

    f.setWrite(async () => {
      throw new Error(reason);
    });
    f.maintenance.request('one');
    await expect(f.flush()).resolves.toBeUndefined();
    f.maintenance.request('one');
    await f.flush();
    expect(f.writes).toHaveLength(1);
  },
);

test('disposal aborts an owned process and keeps single-flight until that process settles', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const other = createHistoryMaintenance(f.options);

  onTestFinished(async () => {
    release.resolve();
    other.dispose();
  });
  f.setWrite(async () => {
    entered.resolve();
    await release.promise;
  });
  f.maintenance.request('one');
  const pending = f.flush();

  await entered.promise;
  f.maintenance.dispose();
  expect(f.writes[0]?.signal?.aborted).toBe(true);
  f.setTime(300_000);
  other.request('linked');
  await f.flush();
  expect(f.writes).toHaveLength(1);
  release.resolve();
  await pending;
  other.request('linked');
  await f.flush();
  expect(f.writes).toHaveLength(2);
});

test('invalidating a scheduled repository prevents its write after reopen at the same path', async () => {
  const f = await fixture();

  f.maintenance.request('one');
  f.maintenance.invalidate('one');
  await f.flush();
  expect(f.commands).toHaveLength(0);
  f.maintenance.request('one');
  await f.flush();
  expect(f.writes).toHaveLength(1);
  f.maintenance.dispose();
  f.setTime(300_000);
  f.maintenance.request('one');
  await f.flush();
  expect(f.writes).toHaveLength(1);
});
