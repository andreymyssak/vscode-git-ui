import { assert, expect, test } from 'vitest';

import { parseRequest } from '../../src/extension/panel/protocol';
import type { HistoryFilters } from '../../src/shared/model';

const filters: HistoryFilters = {
  regex: true,
  matchCase: true,
  author: {
    kind: 'selected',
    identities: [{ name: 'Developer', email: 'dev@example.test' }],
  },
  date: '24h',
};
const request = (body: unknown) => ({
  requestId: 'filters',
  repositoryId: 'repo',
  generation: 1,
  body,
});

test('history and restore accept validated filters, with filters optional for history', () => {
  const history = {
    kind: 'history',
    scope: { kind: 'head' },
    text: '^Fix',
    cursor: null,
  };

  assert.ok(parseRequest(request(history)));
  expect(parseRequest(request({ ...history, filters }))?.body).toStrictEqual({
    ...history,
    filters,
  });
  const restore = {
    kind: 'restore',
    scope: { kind: 'head' },
    text: '',
    selection: null,
    anchor: null,
    filters,
  };

  expect(parseRequest(request(restore))?.body).toStrictEqual(restore);
  const calendar = {
    ...filters,
    date: { kind: 'range', from: '2026-10-01', to: null },
  };

  expect(
    parseRequest(request({ ...history, filters: calendar }))?.body,
  ).toStrictEqual({ ...history, filters: calendar });
});
test('author picker requests carry no arbitrary query or command arguments', () => {
  assert.ok(parseRequest(request({ kind: 'choose-authors' })));
  expect(
    parseRequest(request({ kind: 'choose-authors', command: 'push' })),
  ).toBe(null);
});
test('invalid date notifications carry no arbitrary message or command arguments', () => {
  expect(parseRequest(request({ kind: 'invalid-date-filter' }))?.body).toEqual({
    kind: 'invalid-date-filter',
  });
  expect(
    parseRequest(
      request({ kind: 'invalid-date-filter', message: 'Forged error' }),
    ),
  ).toBeNull();
  expect(
    parseRequest(request({ kind: 'invalid-date-filter', command: 'push' })),
  ).toBeNull();
});
test('worktree refresh accepts an explicit retry flag without extra arguments', () => {
  expect(
    parseRequest(request({ kind: 'worktrees', retry: true }))?.body,
  ).toEqual({ kind: 'worktrees', retry: true });
  expect(parseRequest(request({ kind: 'worktrees', retry: false }))).toBeNull();
  expect(
    parseRequest(request({ kind: 'worktrees', retry: 'true' })),
  ).toBeNull();
  expect(
    parseRequest(request({ kind: 'worktrees', retry: true, command: 'push' })),
  ).toBeNull();
});
test('forged filter shapes are rejected before repository access', () => {
  for (const invalid of [
    null,
    { ...filters, regex: 'yes' },
    { ...filters, date: 'yesterday' },
    {
      ...filters,
      date: { kind: 'range', from: '2026-10-07', to: '2026-10-01' },
    },
    { ...filters, date: { kind: 'range', from: null, to: '--all' } },
    { ...filters, command: 'push' },
    { ...filters, author: { kind: 'me', email: 'someone@example.test' } },
    { ...filters, author: { kind: 'selected', identities: [] } },
    {
      ...filters,
      author: {
        kind: 'selected',
        identities: [{ name: 'bad\0name', email: '' }],
      },
    },
    {
      ...filters,
      author: { kind: 'selected', identities: [{ name: '', email: '' }] },
    },
    {
      ...filters,
      author: {
        kind: 'selected',
        identities: [
          { name: 'Valid', email: 'dev@example.test', path: '/private' },
        ],
      },
    },
    {
      ...filters,
      author: {
        kind: 'selected',
        identities: Array.from({ length: 101 }, () => ({
          name: 'Dev',
          email: 'dev@example.test',
        })),
      },
    },
  ]) {
    expect(
      parseRequest(
        request({
          kind: 'history',
          scope: { kind: 'head' },
          text: '',
          cursor: null,
          filters: invalid,
        }),
      ),
    ).toBe(null);
  }
});
