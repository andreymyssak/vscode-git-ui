import { expect, test } from 'vitest';

import { ReferencePublications } from '../../src/extension/panel/reference-publications';
import type { HistoryPageUpdate } from '../../src/shared/messages';
import { parsePanelResult } from '../../src/shared/panel-result';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { a, page } from '../fixtures/controller';

const repository = {
  id: 'one',
  label: 'One',
  rootUri: 'file:///one',
  headSha: a,
  branch: 'main',
};

test('retained references require an authoritative snapshot in the same generation', () => {
  const { refs, ...rows } = page([a]);

  void refs;
  const message = {
    requestId: 'page',
    repositoryId: 'one',
    generation: 1,
    body: {
      kind: 'history' as const,
      page: rows,
      scope: { kind: 'head' as const },
      text: '',
      append: false,
      repository,
    },
  };
  const state = initialView();

  expect(parsePanelResult(message)).toEqual(message);
  expect(reduceView(state, { kind: 'host', message })).toBe(state);
});

test('publication resets include references and annotation-only messages omit unchanged maps', () => {
  const publications = new ReferencePublications();
  const enrichment = {
    scopeId: 'fixture',
    shas: [a],
    refs: page([]).refs,
    annotations: { user: null, currentBranch: [a] },
  };
  const first = publications.prepare(
    { kind: 'history-enrichment', enrichment },
    'one',
    1,
  );

  first.commit();
  const next = publications.prepare(
    { kind: 'history-enrichment', enrichment },
    'one',
    1,
  );

  expect(
    next.body.kind === 'history-enrichment' && next.body.enrichment.refs,
  ).toBeUndefined();
  const reset = publications.prepare(
    { kind: 'history-enrichment', enrichment },
    'one',
    2,
  );

  expect(
    reset.body.kind === 'history-enrichment' && reset.body.enrichment.refs,
  ).toEqual(enrichment.refs);
});

test('a reference removal remains an explicit empty snapshot', () => {
  const publications = new ReferencePublications();
  const snapshot = publications.prepare(
    { kind: 'references', references: page([]).refs },
    'one',
    1,
  );

  snapshot.commit();
  const rows: HistoryPageUpdate = { ...page([]), refs: [] };
  const result = publications.prepare(
    {
      kind: 'history',
      page: rows,
      scope: { kind: 'head' },
      text: '',
      append: true,
      repository,
    },
    'one',
    1,
  );

  expect(result.body.kind === 'history' && result.body.page.refs).toEqual([]);
});
