import { expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

import { SourceControlService } from '../../src/extension/source-control/service';
import type {
  SourceControlDraftAck,
  SourceControlState,
} from '../../src/shared/source-control';
import { parseSourceControlResponse } from '../../src/shared/source-control-protocol';

const host = vi.hoisted(() => {
  const event = () => ({ dispose() {} });
  const file = {
    path: 'sample.txt',
    originalPath: 'sample.txt',
    status: ' M',
    staged: false,
    working: true,
    untracked: false,
  };

  return {
    event,
    backend: {
      dispose() {},
      repositories: () => [
        {
          id: 'repo',
          rootUri: 'file:///repo',
          label: 'repo',
          branch: 'main',
          headSha: 'a'.repeat(40),
        },
      ],
      root: () => ({ fsPath: '/repo' }),
      subscribeRepositories: event,
      subscribe: event,
      workingChanges: async () => [file],
      stashes: async () => [],
      operation: async () => [],
      status: async () => {},
      headCommit: vi.fn(async () => ({
        hash: 'a'.repeat(40),
        message: 'Previous commit',
      })),
      prepareChanges: async () => ({
        amendPublished: false,
        write: async () => ({ sha: 'b'.repeat(40) }),
      }),
    },
  };
});

vi.mock('../../src/extension/git/source-control/index', () => ({
  createSourceControlBackend: async () => host.backend,
}));
vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
    textDocuments: [],
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
  Uri: {
    parse: () => ({ fsPath: '/repo' }),
    joinPath: (_root: unknown, ...parts: string[]) => ({
      toString: () => `file:///repo/${parts.join('/')}`,
    }),
  },
  ProgressLocation: { SourceControl: 1 },
  window: {
    withProgress: async (_options: unknown, work: () => Promise<void>) =>
      work(),
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

async function fixture() {
  host.backend.headCommit.mockClear();
  function get<T>(key: string): T | undefined;
  function get<T>(key: string, defaultValue: T): T;
  function get<T>(...args: [string, T?]): T | undefined {
    return args[1];
  }

  const states: SourceControlState[] = [];
  const acks: SourceControlDraftAck[] = [];
  const storage: vscode.Memento = {
    get,
    keys: () => [],
    update: async () => {},
  };
  const service = new SourceControlService(
    storage,
    (state) => states.push(state),
    undefined,
    (ack) => acks.push(ack),
  );

  await service.refresh();
  service.model.requireRepository('repo').checked.setFile('sample.txt', true);
  service.model.setDraft('repo', 'My commit');

  return { service, states, acks };
}

test('a completed Commit releases editing while an unrelated stash read is pending', async (t) => {
  const { service, states } = await fixture();
  const stashes = deferred<[]>();
  const started = deferred<void>();
  const read = vi
    .spyOn(host.backend, 'stashes')
    .mockImplementation(async () => {
      started.resolve();

      return stashes.promise;
    });
  const pending = service.handle({ kind: 'commit', repositoryId: 'repo' });

  t.onTestFinished(async () => {
    stashes.resolve([]);
    await pending;
    read.mockRestore();
    service.dispose();
  });
  await started.promise;
  await vi.waitFor(() =>
    expect(states.at(-1)).toMatchObject({ busy: false, activity: null }),
  );
  await service.handle({
    kind: 'message',
    repositoryId: 'repo',
    message: 'Next commit',
    editId: 'next',
  });
  expect(service.model.draft('repo')).toBe('Next commit');
});

test('Commit failures are reported without waiting for a stash refresh', async (t) => {
  const { service, states } = await fixture();
  const stashes = deferred<[]>();
  const started = deferred<void>();
  const read = vi
    .spyOn(host.backend, 'stashes')
    .mockImplementation(async () => {
      started.resolve();

      return stashes.promise;
    });
  const prepare = vi
    .spyOn(host.backend, 'prepareChanges')
    .mockRejectedValue(new Error('Write failed'));
  const pending = service.handle({ kind: 'commit', repositoryId: 'repo' });

  t.onTestFinished(async () => {
    stashes.resolve([]);
    await pending;
    read.mockRestore();
    prepare.mockRestore();
    service.dispose();
  });
  await started.promise;
  await vi.waitFor(() => expect(service.model.error).toBe('Write failed'));
  expect(states.at(-1)).toMatchObject({ busy: false });
});

for (const { amend, title } of [
  { amend: false, title: 'Committing checked files…' },
  { amend: true, title: 'Amending last commit…' },
])
  test(`Commit publishes ${title} before slow native command contexts settle`, async (t) => {
    const { service, states } = await fixture();

    if (amend)
      service.model.setAmend('repo', {
        headSha: 'a'.repeat(40),
        message: 'Previous commit',
      });
    const contexts = deferred<void>();
    const context = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockImplementation(async () => {
        await contexts.promise;

        return undefined;
      });

    t.onTestFinished(() => {
      contexts.resolve();
      context.mockRestore();
      service.dispose();
    });
    const pending = service.handle({ kind: 'commit', repositoryId: 'repo' });

    expect(states.at(-1)).toMatchObject({
      busy: true,
      activity: { repositoryId: 'repo', title },
    });
    contexts.resolve();
    await pending;
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({ busy: false, activity: null }),
    );
    expect(service.model.draft('repo')).toBe('');
    const completed = states.length;

    await Promise.resolve();
    expect(states).toHaveLength(completed);
  });

test('Amend publishes its last-commit read activity and clears it after loading the message', async (t) => {
  const { service, states } = await fixture();
  const head = deferred<{ hash: string; message: string }>();
  const read = vi
    .spyOn(host.backend, 'headCommit')
    .mockImplementation(() => head.promise);

  t.onTestFinished(() => {
    head.resolve({ hash: 'a'.repeat(40), message: 'Previous commit' });
    read.mockRestore();
    service.dispose();
  });
  const pending = service.handle({
    kind: 'amend',
    repositoryId: 'repo',
    enabled: true,
  });

  expect(states.at(-1)).toMatchObject({
    busy: false,
    activity: { repositoryId: 'repo', title: 'Loading last commit…' },
  });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  head.resolve({ hash: 'a'.repeat(40), message: 'Previous commit' });
  await pending;
  await vi.waitFor(() =>
    expect(states.at(-1)).toMatchObject({ activity: null }),
  );
  expect(service.model.draft('repo')).toBe('Previous commit');
});

test('a late Amend read clears activity and preserves a newer edited draft', async (t) => {
  const { service, states } = await fixture();
  const head = deferred<{ hash: string; message: string }>();
  const read = vi
    .spyOn(host.backend, 'headCommit')
    .mockImplementation(() => head.promise);

  t.onTestFinished(() => {
    head.resolve({ hash: 'a'.repeat(40), message: 'Old message' });
    read.mockRestore();
    service.dispose();
  });
  const pending = service.handle({
    kind: 'amend',
    repositoryId: 'repo',
    enabled: true,
  });

  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await service.handle({
    kind: 'message',
    repositoryId: 'repo',
    message: 'New draft',
    editId: 'new',
  });
  head.resolve({ hash: 'a'.repeat(40), message: 'Old message' });
  await pending;
  await vi.waitFor(() =>
    expect(states.at(-1)).toMatchObject({ activity: null }),
  );
  expect(service.model.draft('repo')).toBe('New draft');
  expect(service.model.requireRepository('repo').commitMode.kind).toBe('new');
});

test('an Amend read failure clears inline activity and keeps the draft', async (t) => {
  const { service, states } = await fixture();
  const read = vi
    .spyOn(host.backend, 'headCommit')
    .mockRejectedValue(new Error('HEAD unavailable'));

  t.onTestFinished(() => {
    read.mockRestore();
    service.dispose();
  });
  await service.handle({ kind: 'amend', repositoryId: 'repo', enabled: true });
  await vi.waitFor(() =>
    expect(states.at(-1)).toMatchObject({ activity: null }),
  );
  expect(service.model.error).toBe('HEAD unavailable');
  expect(service.model.draft('repo')).toBe('My commit');
});

test('a late Amend read cannot clear a newer Commit activity', async (t) => {
  const { service, states } = await fixture();
  const head = deferred<{ hash: string; message: string }>();
  const write = deferred<void>();
  const read = vi
    .spyOn(host.backend, 'headCommit')
    .mockImplementation(() => head.promise);
  const prepare = vi
    .spyOn(host.backend, 'prepareChanges')
    .mockImplementation(async () => {
      await write.promise;

      return {
        amendPublished: false,
        write: async () => ({ sha: 'b'.repeat(40) }),
      };
    });

  t.onTestFinished(() => {
    head.resolve({ hash: 'a'.repeat(40), message: 'Old message' });
    write.resolve();
    read.mockRestore();
    prepare.mockRestore();
    service.dispose();
  });
  const amend = service.handle({
    kind: 'amend',
    repositoryId: 'repo',
    enabled: true,
  });

  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const commit = service.handle({ kind: 'commit', repositoryId: 'repo' });

  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  head.resolve({ hash: 'a'.repeat(40), message: 'Old message' });
  await amend;
  expect(states.at(-1)).toMatchObject({
    busy: true,
    activity: { title: 'Committing checked files…' },
  });
  write.resolve();
  await commit;
  await vi.waitFor(() =>
    expect(states.at(-1)).toMatchObject({ busy: false, activity: null }),
  );
});

test.each([
  {},
  '',
  { repositoryId: 'repo', title: 1 },
  { repositoryId: '', title: 'Loading…' },
])('rejects malformed inline activity from the host: %j', async (activity) => {
  const { service, states } = await fixture();

  try {
    expect(
      parseSourceControlResponse({
        kind: 'source-control-state',
        state: { ...states.at(-1), activity },
      }),
    ).toBeNull();
  } finally {
    service.dispose();
  }
});

test('typing acknowledges only the canonical draft without publishing the repository tree', async (t) => {
  const { service, states, acks } = await fixture();

  t.onTestFinished(() => service.dispose());
  await vi.waitFor(() =>
    expect(states.at(-1)?.repositories[0]?.changes.kind).toBe('ready'),
  );
  const publications = states.length;

  for (let i = 1; i <= 12; i++)
    await service.handle({
      kind: 'message',
      repositoryId: 'repo',
      message: `draft ${i}`,
      editId: `session:${i}`,
    });
  expect(states).toHaveLength(publications);
  expect(acks).toHaveLength(12);
  expect(acks.at(-1)).toEqual({
    kind: 'source-control-draft',
    repositoryId: 'repo',
    message: 'draft 12',
    editId: 'session:12',
    generating: false,
  });
  expect(service.model.draft('repo')).toBe('draft 12');
  await service.handle({ kind: 'ready', repositoryId: 'repo', tab: 'commit' });
  await vi.waitFor(() =>
    expect(states.at(-1)?.repositories[0]?.draft).toBe('draft 12'),
  );
});
