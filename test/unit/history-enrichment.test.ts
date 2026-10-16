import { expect, test, vi } from 'vitest';

import type { GitApiAccess } from '../../src/extension/git/api';
import type { GitCli } from '../../src/extension/git/cli';
import {
  createHistoryQueries,
  type LazyHistoryEnrichment,
} from '../../src/extension/git/history';
import type { HistoryEnrichment } from '../../src/shared/model';
import { parsePanelResult } from '../../src/shared/panel-result';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { a, b, fixture, page } from '../fixtures/controller';
import { completeHistoryShallow } from '../fixtures/history-shallow';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

test('the bridge accepts complete enrichment and rejects malformed annotation metadata', () => {
  const message = {
    repositoryId: 'one',
    requestId: 'history',
    generation: 1,
    body: {
      kind: 'history-enrichment',
      enrichment: {
        scopeId: 'fixture',
        shas: [a],
        refs: page([]).refs,
        annotations: { user: null, currentBranch: [a] },
      },
    },
  };

  expect(parsePanelResult(message)).toEqual(message);
  for (const broken of [
    { ...message.body.enrichment, shas: null },
    { ...message.body.enrichment, refs: [{}] },
    {
      ...message.body.enrichment,
      annotations: { user: {}, currentBranch: [] },
    },
  ])
    expect(
      parsePanelResult({
        ...message,
        body: { ...message.body, enrichment: broken },
      }),
    ).toBeNull();
});

test('first-page commits do not wait for tracking or current-branch highlighting', async (t) => {
  const tracking = deferred<string>();
  const ancestry = deferred<string>();
  const record = { hash: a, parents: [b], message: 'First commit' };
  const repository = {
    state: { HEAD: { name: 'main', commit: a } },
    getRefs: async () => [
      { type: 0, name: 'main', commit: a },
      { type: 0, name: 'other', commit: b },
    ],
    getCommit: async () => record,
    log: vi.fn(async () => [record]),
  };
  const reader = createHistoryQueries(
    { repository: () => repository } as unknown as GitApiAccess,
    {
      readOnly() {
        return this;
      },
      run: async (_id: string, args: string[]) =>
        args[0] === 'for-each-ref' ? tracking.promise : 'dev@example.test',
      stream: async (
        _id: string,
        _args: string[],
        consume: (chunk: Buffer) => boolean,
      ) => {
        consume(Buffer.from(await ancestry.promise));
      },
    } as unknown as GitCli,
    Date.now,
    completeHistoryShallow,
  );
  let pending: Promise<HistoryEnrichment> | undefined;
  const read = reader.page(
    'one',
    {
      scope: { kind: 'all' },
      text: '',
      cursor: null,
    },
    undefined,
    undefined,
    (value) => {
      pending = value;
    },
  );

  t.onTestFinished(async () => {
    tracking.resolve('');
    ancestry.resolve(a + '\n');
    await Promise.allSettled([read, ...(pending ? [pending] : [])]);
  });
  await vi.waitFor(() => expect(repository.log).toHaveBeenCalled(), {
    timeout: 200,
  });
  const first = await read;

  expect(first.commits.map((commit) => commit.sha)).toEqual([a]);
  expect(first.refs[0]?.tracking).toBeUndefined();
  expect(first.annotations?.currentBranch).toEqual([]);
  expect(pending).toBeDefined();
  tracking.resolve(`refs/heads/main\0${a}\0refs/remotes/origin/main\0behind 2`);
  ancestry.resolve(a + '\n');
  const enriched = await pending;

  expect(enriched?.refs[0]?.tracking?.behind).toBe(2);
  expect(enriched?.annotations.currentBranch).toEqual([a]);
});

test('the panel publishes usable history before optional enrichment, then merges the late data', async (t) => {
  let state = initialView();
  const pending = deferred<HistoryEnrichment>();
  const f = fixture(true, true, {
    send(message) {
      state = reduceView(state, { kind: 'host', message });
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (_id, _input, _signal, _refs, onEnrichment) => {
    onEnrichment?.(pending.promise);

    return page([a]);
  };

  await f.controller.selectRepository('one');
  expect(state.commits.map((commit) => commit.sha)).toEqual([a]);
  expect(state.loading).toBe(false);
  pending.resolve({
    scopeId: 'fixture',
    shas: [a],
    refs: page([]).refs.map((ref) => ({
      ...ref,
      tracking: { upstream: 'refs/remotes/origin/main', ahead: 0, behind: 2 },
    })),
    annotations: { user: null, currentBranch: [a] },
  });
  await vi.waitFor(() => expect(state.refs[0]?.tracking?.behind).toBe(2));
  expect(state.annotations.currentBranch).toEqual([a]);
  expect(state.loading).toBe(false);
});

test('lazy history metadata starts only when requested and accepts a replacement owner', async (t) => {
  const original = new AbortController();
  const replacement = new AbortController();
  const metadata = vi.fn(
    async (_id: string, _args: string[], signal?: AbortSignal) => {
      signal?.throwIfAborted();

      return '';
    },
  );
  const record = { hash: a, parents: [b], message: 'Commit' };
  const reader = createHistoryQueries(
    {
      repository: () => ({
        state: { HEAD: { name: 'main', commit: a } },
        getRefs: async () => [{ type: 0, name: 'main', commit: a }],
        getCommit: async () => record,
        log: async () => [record],
      }),
    } as unknown as GitApiAccess,
    {
      readOnly(signal?: AbortSignal) {
        signal?.throwIfAborted();

        return this;
      },
      run: metadata,
    } as unknown as GitCli,
    Date.now,
    completeHistoryShallow,
  );
  const pending: { read: LazyHistoryEnrichment | null } = { read: null };

  t.onTestFinished(() => reader.dispose());
  const result = await reader.page(
    'one',
    { scope: { kind: 'head' }, text: '', cursor: null },
    original.signal,
    undefined,
    undefined,
    {
      kind: 'lazy-enrichment',
      receive: (read) => {
        pending.read = read;
      },
    },
  );

  expect(result.commits.map(({ sha }) => sha)).toEqual([a]);
  expect(metadata).not.toHaveBeenCalled();
  original.abort();
  expect(pending.read).not.toBeNull();
  const enrichment = await pending.read!(replacement.signal);

  expect(enrichment.annotations.currentBranch).toEqual([a]);
  expect(metadata).toHaveBeenCalled();
});

test('enrichment cannot publish after switching repositories', async (t) => {
  const pending = deferred<HistoryEnrichment>();
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (id, _input, _signal, _refs, onEnrichment) => {
    if (id === 'one') onEnrichment?.(pending.promise);

    return page([a]);
  };

  await f.controller.selectRepository('one');
  await f.controller.selectRepository('two');
  pending.resolve({
    scopeId: 'fixture',
    shas: [a],
    refs: [],
    annotations: { user: null, currentBranch: [a] },
  });
  await pending.promise;
  await Promise.resolve();
  expect(
    f.sent.some(
      (message) =>
        message.repositoryId === 'one' &&
        message.body.kind === 'history-enrichment',
    ),
  ).toBe(false);
});

test('failed optional metadata does not fail the usable page or keep it loading', async (t) => {
  let state = initialView();
  const f = fixture(true, true, {
    send(message) {
      state = reduceView(state, { kind: 'host', message });
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (_id, _input, _signal, _refs, onEnrichment) => {
    onEnrichment?.(Promise.reject(new Error('Tracking timed out')));

    return page([a]);
  };

  await f.controller.selectRepository('one');
  expect(state.commits.map((commit) => commit.sha)).toEqual([a]);
  expect(state.loading).toBe(false);
  expect(state.error).toBeNull();
});

test('a completed navigation releases its temporary owner without dropping valid history metadata', async (t) => {
  const pending = deferred<HistoryEnrichment>();
  let navigating = true;
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (_id, _input, _signal, _refs, onEnrichment) => {
    onEnrichment?.(pending.promise);

    return page([a]);
  };

  await f.controller.selectRepository('one', true, () => navigating);
  navigating = false;
  pending.resolve({
    scopeId: 'fixture',
    shas: [a],
    refs: page([]).refs,
    annotations: { user: null, currentBranch: [a] },
  });
  await vi.waitFor(() =>
    expect(
      f.sent.some((message) => message.body.kind === 'history-enrichment'),
    ).toBe(true),
  );
});

test('tracking enrichment during action startup does not invalidate an unchanged checkout target', async (t) => {
  const pending = deferred<HistoryEnrichment>();
  const delivered = deferred<void>();
  const f = fixture(true, true, {
    async send(message) {
      if (message.body.kind === 'history-enrichment') delivered.resolve();
      if (
        message.body.kind === 'operation-progress' &&
        message.body.operation?.phase === 'running'
      ) {
        pending.resolve({
          scopeId: 'fixture',
          shas: [a],
          refs: page([]).refs.map((ref) => ({
            ...ref,
            tracking: {
              upstream: 'refs/remotes/origin/main',
              ahead: 0,
              behind: 2,
            },
          })),
          annotations: { user: null, currentBranch: [a] },
        });
        await delivered.promise;
      }
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  let reads = 0;

  f.adapter.history = async (_id, _input, _signal, _refs, onEnrichment) => {
    if (++reads === 1) onEnrichment?.(pending.promise);

    return page([a]);
  };

  const operate = vi.spyOn(f.adapter, 'operate');

  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'checkout', refId: 'refs/heads/main' },
    }),
  );
  expect(operate).toHaveBeenCalledTimes(1);
  expect(operate.mock.calls[0]?.slice(0, 2)).toEqual([
    'one',
    { kind: 'checkout', refId: 'refs/heads/main', expectedSha: a },
  ]);
});

test('a finished write rejects old enrichment before its replacement query starts', async (t) => {
  const pending = deferred<HistoryEnrichment>();
  let oldSignal: AbortSignal | undefined;
  const f = fixture(true, true, {
    async send(message) {
      if (
        message.body.kind === 'operation-progress' &&
        message.body.operation?.phase === 'refreshing'
      ) {
        expect(oldSignal?.aborted).toBe(true);
        pending.resolve({
          scopeId: 'fixture',
          shas: [a],
          refs: [],
          annotations: { user: null, currentBranch: [a] },
        });
        await pending.promise;
      }
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  let reads = 0;

  f.adapter.history = async (_id, _input, signal, _refs, onEnrichment) => {
    if (++reads === 1) {
      oldSignal = signal;
      onEnrichment?.(pending.promise);
    }

    return page([a]);
  };

  await f.controller.selectRepository('one');
  await f.controller.handle(
    f.request({
      kind: 'action',
      action: { kind: 'update-branch', refId: 'refs/heads/main' },
    }),
  );
  expect(
    f.sent.some((message) => message.body.kind === 'history-enrichment'),
  ).toBe(false);
});

test('pagination shares tracking while a cached revisit requests fresh counts', async () => {
  const tracking = vi.fn(
    async () =>
      `refs/heads/main\0${a}\0refs/remotes/origin/main\0behind ${tracking.mock.calls.length}`,
  );
  const records = Array.from({ length: 201 }, (_, index) => ({
    hash: (index + 1).toString(16).padStart(40, '0'),
    parents: [b],
    message: 'Commit',
  }));
  const log = vi.fn(async ({ skip = 0 }: { skip?: number }) =>
    records.slice(skip, skip + 200),
  );
  const reader = createHistoryQueries(
    {
      repository: () => ({
        state: { HEAD: { name: 'main', commit: a } },
        getRefs: async () => [{ type: 0, name: 'main', commit: a }],
        getCommit: async () => ({ hash: a, parents: [b], message: 'Tip' }),
        log,
      }),
    } as unknown as GitApiAccess,
    {
      readOnly() {
        return this;
      },
      run: async (_id: string, args: string[]) =>
        args[0] === 'for-each-ref' ? tracking() : '',
    } as unknown as GitCli,
    Date.now,
    completeHistoryShallow,
  );
  const input = { scope: { kind: 'head' as const }, text: '', cursor: null };
  const metadata: Promise<HistoryEnrichment>[] = [];
  const first = await reader.page(
    'one',
    input,
    undefined,
    undefined,
    (pending) => metadata.push(pending),
  );

  await metadata[0];
  const next = await reader.page(
    'one',
    { ...input, cursor: first.nextCursor },
    undefined,
    undefined,
    (pending) => metadata.push(pending),
  );

  expect(next.refs[0]?.tracking?.behind).toBe(1);
  await metadata[1];
  expect(tracking).toHaveBeenCalledTimes(1);
  await reader.page('one', input, undefined, undefined, (pending) =>
    metadata.push(pending),
  );
  expect((await metadata[2])?.refs[0]?.tracking?.behind).toBe(2);
  expect(log).toHaveBeenCalledTimes(2);
});

test('appending a page keeps the user highlighting that already arrived', () => {
  let state = initialView();
  const repository = {
    id: 'one',
    label: 'One',
    rootUri: 'file:///one',
    branch: 'main',
    headSha: a,
  };
  const send = (
    append: boolean,
    commits: string[],
    user: HistoryEnrichment['annotations']['user'],
  ) => {
    state = reduceView(state, {
      kind: 'host',
      message: {
        repositoryId: 'one',
        requestId: 'history',
        generation: 1,
        body: {
          kind: 'history',
          repository,
          scope: { kind: 'head' },
          text: '',
          append,
          page: { ...page(commits), annotations: { user, currentBranch: [] } },
        },
      },
    });
  };

  send(false, [a], { name: '', email: 'dev@example.test' });
  send(true, [b], null);
  expect(state.annotations.user?.email).toBe('dev@example.test');
});

test('enrichment merges a loaded page without losing annotations from another page', () => {
  let state = initialView();
  const repository = {
    id: 'one',
    label: 'One',
    rootUri: 'file:///one',
    branch: 'main',
    headSha: a,
  };

  state = reduceView(state, {
    kind: 'host',
    message: {
      repositoryId: 'one',
      requestId: 'history',
      generation: 1,
      body: {
        kind: 'history',
        repository,
        scope: { kind: 'all' },
        text: '',
        append: false,
        page: {
          ...page([a, b]),
          annotations: { user: null, currentBranch: [b] },
        },
      },
    },
  });
  const enriched = {
    kind: 'host' as const,
    message: {
      repositoryId: 'one',
      requestId: 'history',
      generation: 1,
      body: {
        kind: 'history-enrichment' as const,
        enrichment: {
          scopeId: 'fixture',
          shas: [a],
          refs: page([]).refs,
          annotations: {
            user: { name: '', email: 'dev@example.test' },
            currentBranch: [a],
          },
        },
      },
    },
  };

  expect(reduceView(state, enriched).annotations.currentBranch).toEqual([a, b]);
  for (const enrichment of [
    { ...enriched.message.body.enrichment, scopeId: 'obsolete' },
    { ...enriched.message.body.enrichment, shas: ['c'.repeat(40)] },
  ])
    expect(
      reduceView(state, {
        ...enriched,
        message: {
          ...enriched.message,
          body: { kind: 'history-enrichment', enrichment },
        },
      }),
    ).toBe(state);
  state = { ...state, referencesReady: false };
  expect(reduceView(state, enriched)).toBe(state);
});
