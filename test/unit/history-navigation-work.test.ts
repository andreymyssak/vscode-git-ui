import { expect, test, vi } from 'vitest';

import type { HistoryEnrichment } from '../../src/shared/model';
import { a, b, fixture, page } from '../fixtures/controller';

test('navigation continues a valid loaded prefix without waiting for optional metadata', async (t) => {
  const f = fixture();

  t.onTestFinished(() => f.controller.dispose());
  const cursors: (string | null)[] = [];
  let deferred = false;

  f.adapter.history = async (
    _id,
    query,
    _signal,
    _refs,
    _enrichment,
    options,
  ) => {
    cursors.push(query.cursor);
    if (query.cursor === 'later') {
      deferred = options?.kind === 'lazy-enrichment';
      options?.receive(async () => ({
        scopeId: 'fixture',
        shas: [b],
        refs: page([]).refs,
        annotations: { user: null, currentBranch: [b] },
      }));

      return page([b]);
    }

    return { ...page([a]), nextCursor: 'later' };
  };

  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: page([b]).commits[0]!,
  });
  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'go-to', input: b }));

  expect(cursors).toEqual([null, 'later']);
  expect(deferred).toBe(true);
  expect(
    f.sent.filter((message) => message.body.kind === 'history').at(-1)?.body,
  ).toMatchObject({ page: { commits: [{ sha: a }, { sha: b }] } });
});

test('refresh restores a deep selection with one history publication before optional enrichment', async (t) => {
  const f = fixture();
  const c = 'c'.repeat(40);
  const reads: (string | null)[] = [];
  const started: string[] = [];
  let initial = true;

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (
    _id,
    query,
    _signal,
    _refs,
    _enrichment,
    options,
  ) => {
    if (initial) return page([a, b, c]);
    reads.push(query.cursor);
    const sha = query.cursor === null ? a : query.cursor === 'second' ? b : c;
    const result = {
      ...page([sha]),
      nextCursor: sha === a ? 'second' : sha === b ? 'third' : null,
    };

    options?.receive(async (): Promise<HistoryEnrichment> => {
      started.push(sha);

      return {
        scopeId: 'fixture',
        shas: [sha],
        refs: result.refs,
        annotations: { user: null, currentBranch: [sha] },
      };
    });

    return result;
  };

  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'select-commit', sha: c }));
  initial = false;
  f.sent.length = 0;
  await f.controller.handle(f.request({ kind: 'refresh' }));

  expect(reads).toEqual([null, 'second', 'third']);
  const publications = f.sent.filter(
    (message) => message.body.kind === 'history',
  );

  expect(publications).toHaveLength(1);
  expect(publications[0]?.body).toMatchObject({
    page: { commits: [{ sha: a }, { sha: b }, { sha: c }] },
  });
  expect(started).toEqual([a, b, c]);
  expect(
    f.sent.filter((message) => message.body.kind === 'selection').at(-1)?.body,
  ).toMatchObject({ sha: c });
});

test('scope-changing navigation starts optional metadata under the replacement query owner', async (t) => {
  const f = fixture(true, true, { offerNavigation: async () => true });
  let discoverySignal: AbortSignal | undefined;
  let metadataSignal: AbortSignal | undefined;

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (
    _id,
    query,
    signal,
    _refs,
    _enrichment,
    options,
  ) => {
    if (query.scope.kind !== 'all') return page([a]);
    discoverySignal = signal;
    options?.receive(async (owner) => {
      metadataSignal = owner;
      owner?.throwIfAborted();

      return {
        scopeId: 'fixture',
        shas: [b],
        refs: page([]).refs,
        annotations: { user: null, currentBranch: [b] },
      };
    });

    return page([b]);
  };

  f.adapter.resolve = async () => ({
    kind: 'commit',
    commit: page([b]).commits[0]!,
  });
  await f.controller.selectRepository('one');
  await f.controller.handle(f.request({ kind: 'go-to', input: b }));
  await vi.waitFor(() =>
    expect(f.sent.some(({ body }) => body.kind === 'history-enrichment')).toBe(
      true,
    ),
  );
  expect(discoverySignal?.aborted).toBe(true);
  expect(metadataSignal?.aborted).toBe(false);
  expect(metadataSignal).not.toBe(discoverySignal);
});

test('a superseded deep navigation never publishes discovered rows or starts their metadata', async (t) => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  let metadataReads = 0;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scanning = new Promise<void>((resolve) => {
    entered = resolve;
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (
    _id,
    query,
    _signal,
    _refs,
    _enrichment,
    options,
  ) => {
    if (query.cursor === null) return { ...page([a]), nextCursor: 'later' };
    entered();
    await delayed;
    options?.receive(async () => {
      metadataReads++;

      return {
        scopeId: 'fixture',
        shas: [b],
        refs: [],
        annotations: { user: null, currentBranch: [] },
      };
    });

    return page([b]);
  };

  f.adapter.resolve = async (_id, input) => ({
    kind: 'commit',
    commit: page([input]).commits[0]!,
  });
  await f.controller.selectRepository('one');
  f.sent.length = 0;
  const older = f.controller.handle(f.request({ kind: 'go-to', input: b }));

  t.onTestFinished(async () => {
    release();
    await older;
  });
  await scanning;
  await f.controller.handle(f.request({ kind: 'go-to', input: a }));
  release();
  await older;
  expect(metadataReads).toBe(0);
  expect(f.sent.filter(({ body }) => body.kind === 'history')).toHaveLength(0);
  expect(
    f.sent.filter(({ body }) => body.kind === 'reveal').map(({ body }) => body),
  ).toEqual([{ kind: 'reveal', sha: a }]);
});
