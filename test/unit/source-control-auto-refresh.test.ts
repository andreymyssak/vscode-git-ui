import { afterEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';

import type { RepositoryEvent } from '../../src/extension/git/repository-event';
import { SourceControlService } from '../../src/extension/source-control/service';
import type { RepositoryInfo } from '../../src/shared/model';
import type {
  SourceControlOperation,
  SourceControlState,
  Stash,
  StashFile,
  WorkingFile,
} from '../../src/shared/source-control';

const host = vi.hoisted(() => {
  const event = () => ({ dispose() {} });
  const statusListeners = new Map<() => void, string>();
  const workingChanges = vi.fn<(id: string) => Promise<WorkingFile[]>>(
    async () => [],
  );
  const repositoryListeners = new Set<(event?: RepositoryEvent) => void>();
  const stashFiles = vi.fn<() => Promise<StashFile[]>>(async () => []);
  const stashes = vi.fn<() => Promise<Stash[]>>(async () => []);
  const operation = vi.fn<() => Promise<SourceControlOperation[]>>(
    async () => [],
  );

  return {
    event,
    statusListeners,
    workingChanges,
    stashes,
    operation,
    stashFiles,
    fireRepository(event: RepositoryEvent) {
      for (const listener of repositoryListeners) listener(event);
    },
    fireStatus(id = 'repo') {
      for (const [listener, repositoryId] of statusListeners)
        if (repositoryId === id) listener();
    },
    backend: {
      dispose() {},
      repositories: vi.fn<() => RepositoryInfo[]>(() => [
        {
          id: 'repo',
          rootUri: 'file:///repo',
          label: 'repo',
          branch: 'main',
          headSha: 'a'.repeat(40),
        },
      ]),
      root: () => ({ fsPath: '/repo' }),
      subscribeRepositories(changed: (event?: RepositoryEvent) => void) {
        repositoryListeners.add(changed);

        return {
          dispose() {
            repositoryListeners.delete(changed);
          },
        };
      },
      subscribe(_id: string, changed: () => void) {
        statusListeners.set(changed, _id);

        return {
          dispose() {
            statusListeners.delete(changed);
          },
        };
      },
      workingChanges,
      stashFiles,
      stashes,
      operation,
    },
  };
});

vi.mock('../../src/extension/git/source-control/index', () => ({
  createSourceControlBackend: async () => host.backend,
}));
vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
    onDidGrantWorkspaceTrust: host.event,
    onDidChangeConfiguration: host.event,
    onDidChangeWorkspaceFolders: host.event,
    onDidChangeTextDocument: host.event,
  },
  extensions: { onDidChange: host.event },
  commands: { executeCommand: async () => {} },
  Uri: { parse: () => ({ fsPath: '/repo' }) },
}));

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

async function fixture() {
  host.backend.repositories.mockReset().mockReturnValue([
    {
      id: 'repo',
      rootUri: 'file:///repo',
      label: 'repo',
      branch: 'main',
      headSha: 'a'.repeat(40),
    },
  ]);
  host.workingChanges.mockReset().mockResolvedValue([]);
  host.stashes.mockReset().mockResolvedValue([]);
  host.stashFiles.mockReset().mockResolvedValue([]);
  host.operation.mockReset().mockResolvedValue([]);
  function get<T>(key: string): T | undefined;
  function get<T>(key: string, fallback: T): T;
  function get<T>(_key: string, fallback?: T): T | undefined {
    return fallback;
  }

  const storage: vscode.Memento = {
    get,
    keys: () => [],
    update: async () => {},
  };
  const states: SourceControlState[] = [];
  const service = new SourceControlService(storage, (state) =>
    states.push(state),
  );

  await service.refresh();
  await vi.waitFor(() =>
    expect(states.at(-1)?.repositories[0]?.changes).toEqual({
      kind: 'ready',
      items: [],
    }),
  );
  vi.useFakeTimers();

  return { service, states };
}

const editedFile: WorkingFile = {
  path: 'sample.txt',
  originalPath: 'sample.txt',
  status: ' M',
  staged: false,
  working: true,
  untracked: false,
};

test('native Git status changes publish saved edits before slow stash and operation reads finish', async (t) => {
  const { service, states } = await fixture();
  const stashes = deferred<Stash[]>();
  const operation = deferred<SourceControlOperation[]>();

  t.onTestFinished(() => {
    stashes.resolve([]);
    operation.resolve([]);
    service.dispose();
  });
  host.workingChanges.mockResolvedValue([editedFile]);
  host.stashes.mockReturnValue(stashes.promise);
  host.operation.mockReturnValue(operation.promise);
  host.fireStatus();
  await vi.advanceTimersByTimeAsync(100);
  expect(states.at(-1)?.repositories[0]?.changes).toEqual({
    kind: 'ready',
    items: [editedFile],
  });
});

test('a stream of native status events cannot indefinitely postpone changed files', async (t) => {
  const { service, states } = await fixture();

  t.onTestFinished(() => service.dispose());
  host.workingChanges.mockResolvedValue([editedFile]);
  host.fireStatus();
  await vi.advanceTimersByTimeAsync(60);
  host.fireStatus();
  await vi.advanceTimersByTimeAsync(60);
  expect(states.at(-1)?.repositories[0]?.changes).toEqual({
    kind: 'ready',
    items: [editedFile],
  });
});

test('an explicit refresh consumes an earlier native event without a late redundant refresh', async (t) => {
  const { service, states } = await fixture();

  t.onTestFinished(() => service.dispose());
  host.workingChanges.mockResolvedValue([editedFile]);
  host.fireStatus();
  await service.refresh();
  const readsAtCompletion = host.workingChanges.mock.calls.length;

  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)?.repositories[0]?.changes).toEqual({
    kind: 'ready',
    items: [editedFile],
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(host.workingChanges).toHaveBeenCalledTimes(readsAtCompletion);
});

test('another repository slow status cannot block the active repository changes', async (t) => {
  const { service, states } = await fixture();
  const other = deferred<WorkingFile[]>();

  t.onTestFinished(() => {
    other.resolve([]);
    service.dispose();
  });
  host.backend.repositories.mockReturnValue([
    {
      id: 'repo',
      rootUri: 'file:///repo',
      label: 'repo',
      branch: 'main',
      headSha: 'a'.repeat(40),
    },
    {
      id: 'other',
      rootUri: 'file:///other',
      label: 'other',
      branch: 'main',
      headSha: 'b'.repeat(40),
    },
  ]);
  host.workingChanges.mockImplementation((id) =>
    id === 'repo' ? Promise.resolve([editedFile]) : other.promise,
  );
  host.fireStatus();
  await vi.advanceTimersByTimeAsync(100);
  expect(
    states.at(-1)?.repositories.find((repo) => repo.info.id === 'repo')
      ?.changes,
  ).toEqual({ kind: 'ready', items: [editedFile] });
});

test('a newer native event invalidates a slow changes read before the next refresh starts', async (t) => {
  const { service, states } = await fixture();
  const old = deferred<WorkingFile[]>();
  const newer = { ...editedFile, path: 'newer.txt', originalPath: 'newer.txt' };

  t.onTestFinished(() => {
    old.resolve([]);
    service.dispose();
  });
  host.workingChanges
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue([newer]);
  host.fireStatus();
  await vi.advanceTimersByTimeAsync(100);
  host.fireStatus();
  old.resolve([editedFile]);
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)?.repositories[0]?.changes).toEqual({
    kind: 'ready',
    items: [],
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(states.at(-1)?.repositories[0]?.changes).toEqual({
    kind: 'ready',
    items: [newer],
  });
});

test('an explicit refresh waits for a newer native event that is still queued', async (t) => {
  const { service, states } = await fixture();
  const old = deferred<WorkingFile[]>();
  let completed = false;

  t.onTestFinished(() => {
    old.resolve([]);
    service.dispose();
  });
  host.workingChanges
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue([editedFile]);
  const pending = service.refresh().then(() => {
    completed = true;
  });

  await vi.advanceTimersByTimeAsync(0);
  host.fireStatus();
  old.resolve([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(states.at(-1)?.repositories[0]?.changes).toEqual({
    kind: 'ready',
    items: [editedFile],
  });
});

test('disposal settles a refresh waiting for a queued native event and removes the subscription', async (t) => {
  const { service } = await fixture();
  const old = deferred<WorkingFile[]>();
  let completed = false;

  t.onTestFinished(() => {
    old.resolve([]);
    service.dispose();
  });
  host.workingChanges.mockReturnValueOnce(old.promise);
  const pending = service.refresh().then(() => {
    completed = true;
  });

  await vi.advanceTimersByTimeAsync(0);
  host.fireStatus();
  service.dispose();
  old.resolve([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(true);
  expect(host.statusListeners.size).toBe(0);
  await pending;
});

test('a repository status event refreshes only that repository, while manual refresh covers both', async (t) => {
  const { service } = await fixture();

  t.onTestFinished(() => service.dispose());
  const first = host.backend.repositories()[0];

  expect(first).toBeDefined();
  host.backend.repositories.mockReturnValue([
    {
      id: 'repo',
      rootUri: 'file:///repo',
      label: 'repo',
      branch: 'main',
      headSha: 'a'.repeat(40),
    },
    {
      id: 'other',
      rootUri: 'file:///other',
      label: 'other',
      branch: 'main',
      headSha: 'b'.repeat(40),
    },
  ]);
  await service.refresh();
  host.workingChanges.mockClear();
  host.stashes.mockClear();
  host.operation.mockClear();
  host.fireStatus('repo');
  await vi.advanceTimersByTimeAsync(100);
  expect(host.workingChanges.mock.calls.map(([id]) => id)).toEqual(['repo']);
  expect(host.stashes).toHaveBeenCalledTimes(1);
  expect(host.operation).toHaveBeenCalledTimes(1);
  host.workingChanges.mockClear();
  await service.refresh();
  expect(host.workingChanges.mock.calls.map(([id]) => id).sort()).toEqual([
    'other',
    'repo',
  ]);
});

test('targeted file refresh skips stash reads and does not revoke a different repository read', async (t) => {
  const { service } = await fixture();

  t.onTestFinished(() => service.dispose());
  host.stashes.mockClear();
  host.operation.mockClear();
  host.workingChanges.mockClear();
  await service.refresh('repo', ['changes', 'operation']);
  expect(host.workingChanges).toHaveBeenCalledTimes(1);
  expect(host.operation).toHaveBeenCalledTimes(1);
  expect(host.stashes).not.toHaveBeenCalled();
});

test('status in repository B cannot discard repository A in-flight result', async (t) => {
  const { service, states } = await fixture();
  const held = deferred<WorkingFile[]>();

  t.onTestFinished(() => {
    held.resolve([]);
    service.dispose();
  });
  host.backend.repositories.mockReturnValue([
    {
      id: 'repo',
      rootUri: 'file:///repo',
      label: 'repo',
      branch: 'main',
      headSha: 'a'.repeat(40),
    },
    {
      id: 'other',
      rootUri: 'file:///other',
      label: 'other',
      branch: 'main',
      headSha: 'b'.repeat(40),
    },
  ]);
  await service.refresh();
  host.workingChanges.mockImplementation((id) =>
    id === 'repo' ? held.promise : Promise.resolve([]),
  );
  host.fireStatus('repo');
  await vi.advanceTimersByTimeAsync(100);
  host.fireStatus('other');
  await vi.advanceTimersByTimeAsync(100);
  held.resolve([editedFile]);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    states.at(-1)?.repositories.find((repo) => repo.info.id === 'repo')
      ?.changes,
  ).toEqual({ kind: 'ready', items: [editedFile] });
});

test('a stash file read from a closed lifetime cannot overwrite replacement files', async (t) => {
  const { service } = await fixture();
  const held = deferred<StashFile[]>();

  t.onTestFinished(() => {
    held.resolve([]);
    service.dispose();
  });
  const sha = 'a'.repeat(40);

  host.stashes.mockResolvedValue([
    {
      sha,
      base: 'b'.repeat(40),
      selector: 'stash@{0}',
      message: 'Fixture',
      date: '2026-10-16T00:00:00Z',
    },
  ]);
  await service.refresh();
  host.stashFiles.mockReturnValueOnce(held.promise).mockResolvedValue([]);
  const old = service.handle({ kind: 'load-stash', repositoryId: 'repo', sha });

  await vi.advanceTimersByTimeAsync(0);
  host.fireRepository({ kind: 'closed', repositoryId: 'repo' });
  host.fireRepository({ kind: 'opened', repositoryId: 'repo' });
  await service.refresh();
  await service.handle({ kind: 'load-stash', repositoryId: 'repo', sha });
  expect(service.model.requireStash('repo', sha).files).toEqual({
    kind: 'ready',
    items: [],
  });
  held.resolve([
    {
      path: 'old.txt',
      originalPath: 'old.txt',
      status: 'M',
      snapshot: 'working',
      oldRef: sha,
      newRef: sha,
      deleted: false,
    },
  ]);
  await old;
  expect(service.model.requireStash('repo', sha).files).toEqual({
    kind: 'ready',
    items: [],
  });
});

test('hidden Changes coalesces native status bursts and refreshes current files once on reveal', async (t) => {
  const { service, states } = await fixture();

  t.onTestFinished(() => service.dispose());
  const reads = host.workingChanges.mock.calls.length;

  await service.setVisible(false);
  host.workingChanges.mockResolvedValue([editedFile]);
  for (let index = 0; index < 20; index++) host.fireStatus();
  await vi.advanceTimersByTimeAsync(1000);
  expect(host.workingChanges).toHaveBeenCalledTimes(reads);
  await service.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(host.workingChanges).toHaveBeenCalledTimes(reads + 1);
  expect(states.at(-1)?.repositories[0]?.changes).toEqual({
    kind: 'ready',
    items: [editedFile],
  });
});

test('revealing Changes with no invalidations republishes cached state without Git reads', async (t) => {
  const { service } = await fixture();

  t.onTestFinished(() => service.dispose());
  const reads = host.workingChanges.mock.calls.length;

  await service.setVisible(false);
  await service.setVisible(true);
  expect(host.workingChanges).toHaveBeenCalledTimes(reads);
});
