import { expect, test } from 'vitest';

import type { PanelBody, Result } from '../../src/shared/messages';
import type { HistoryEnrichment, Reference } from '../../src/shared/model';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { a, b, fixture, page } from '../fixtures/controller';

const refs: Reference[] = Array.from({ length: 10000 }, (_, index) => ({
  id: `refs/heads/topic-${index}`,
  name: `topic-${index}`,
  kind: 'local',
  sha: a,
  remote: null,
}));

test('history appends retain authoritative reference state without repeating its payload', async (t) => {
  let state = initialView();
  const received: Result<PanelBody>[] = [];
  const f = fixture(true, true, {
    send(message) {
      received.push(message);
      state = reduceView(state, { kind: 'host', message });
    },
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (_id, input, _signal, onReferences) => {
    if (!input.cursor) await onReferences?.(refs);

    return {
      ...page(input.cursor ? [b] : [a]),
      refs,
      nextCursor: input.cursor ? null : 'next',
    };
  };

  await f.controller.selectRepository('one');
  const original = state.refs;

  await f.controller.handle({
    requestId: 'next',
    repositoryId: 'one',
    generation: state.generation,
    body: {
      kind: 'history',
      scope: { kind: 'head' },
      text: '',
      cursor: 'next',
    },
  });
  const messages = received.filter(
    (message) => message.body.kind === 'history',
  );

  expect(messages).toHaveLength(2);
  expect(JSON.stringify(messages.at(-1)).length).toBeLessThan(2000);
  expect(state.refs).toBe(original);
  expect(state.commits.map((commit) => commit.sha)).toEqual([a, b]);
  expect(state.refs).toHaveLength(10000);
});

test('changed tracking is published once and annotation-only enrichment retains reference identity', async (t) => {
  let state = initialView();
  const received: Result<PanelBody>[] = [];
  const f = fixture(true, true, {
    send(message) {
      received.push(message);
      state = reduceView(state, { kind: 'host', message });
    },
  });
  let enrich: ((value: HistoryEnrichment) => void) | undefined;
  const pending = new Promise<HistoryEnrichment>((resolve) => {
    enrich = resolve;
  });

  t.onTestFinished(() => f.controller.dispose());
  f.adapter.history = async (
    _id,
    _input,
    _signal,
    onReferences,
    onEnrichment,
  ) => {
    await onReferences?.(refs);
    onEnrichment?.(pending);

    return { ...page([a]), refs };
  };

  await f.controller.selectRepository('one');
  const before = state.refs;
  const tracked = refs.map((ref) => ({
    ...ref,
    tracking: { upstream: 'refs/remotes/origin/main', ahead: 0, behind: 2 },
  }));

  enrich?.({
    scopeId: 'fixture',
    shas: [a],
    refs: tracked,
    annotations: { user: null, currentBranch: [a] },
  });
  await expect.poll(() => state.refs[0]?.tracking?.behind).toBe(2);
  expect(state.refs).not.toBe(before);
});
