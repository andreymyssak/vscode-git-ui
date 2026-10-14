import { assert, expect, test } from 'vitest';

import {
  branchMenuRequest,
  parseRequest,
} from '../../src/extension/panel/protocol';

test('create-and-checkout accepts one selected branch without trusting supplied write targets', () => {
  const context = {
    repositoryId: 'one',
    generation: 1,
    refId: 'refs/heads/topic',
    refSelectionCount: 1,
  };
  const request = branchMenuRequest('create-branch-checkout', context);

  expect(request?.body).toEqual({
    kind: 'action',
    action: { kind: 'create-branch-checkout', refId: 'refs/heads/topic' },
  });
  expect(
    branchMenuRequest('create-branch-checkout', {
      ...context,
      refSelectionCount: 2,
    }),
  ).toBeNull();
  expect(
    parseRequest({
      ...request,
      body: {
        kind: 'action',
        action: {
          kind: 'create-branch-checkout',
          refId: context.refId,
          name: 'forged',
          expectedSha: 'a'.repeat(40),
        },
      },
    }),
  ).toBeNull();
});

test('batch deletion accepts distinct branch IDs and rejects supplied write targets or invalid ranges', () => {
  const action = {
    kind: 'delete-branches',
    refIds: ['refs/heads/alpha', 'refs/heads/beta'],
  };
  const request = {
    requestId: 'delete-many',
    repositoryId: 'one',
    generation: 1,
    body: { kind: 'action', action },
  };

  expect(parseRequest(request)?.body).toStrictEqual(request.body);
  for (const refIds of [
    [],
    ['refs/heads/alpha'],
    ['refs/heads/alpha', 'refs/heads/alpha'],
    ['refs/heads/', 'refs/heads/beta'],
    ['refs/remotes/origin/main', 'refs/heads/beta'],
    ['refs/heads/a\u0000', 'refs/heads/beta'],
    Array.from({ length: 401 }, (_, i) => `refs/heads/${i}`),
  ])
    expect(
      parseRequest({
        ...request,
        body: { kind: 'action', action: { ...action, refIds } },
      }),
    ).toBe(null);
  expect(
    parseRequest({
      ...request,
      body: {
        kind: 'action',
        action: { ...action, expectedSha: 'f'.repeat(40) },
      },
    }),
  ).toBe(null);
});
test('a multi-branch context cannot run a single-branch command', () => {
  const context = {
    repositoryId: 'one',
    generation: 1,
    refId: 'refs/heads/alpha',
    refSelectionCount: 2,
    refIds: ['refs/heads/alpha', 'refs/heads/beta'],
  };

  expect(branchMenuRequest('checkout', context)).toBe(null);
  expect(branchMenuRequest('delete-branch', context)).toBe(null);
});
test('native batch request requires matching count and active membership', () => {
  const context = {
    repositoryId: 'one',
    generation: 1,
    refId: 'refs/heads/alpha',
    refSelectionCount: 2,
    refIds: ['refs/heads/alpha', 'refs/heads/beta'],
  };

  expect(branchMenuRequest('delete-branches', context)?.body).toStrictEqual({
    kind: 'action',
    action: { kind: 'delete-branches', refIds: context.refIds },
  });
  for (const override of [
    { refSelectionCount: 3 },
    { refId: 'refs/heads/other' },
    { refIds: ['refs/heads/alpha', 'refs/heads/alpha'] },
  ])
    expect(
      branchMenuRequest('delete-branches', { ...context, ...override }),
    ).toBe(null);
  const refIds = Array.from({ length: 400 }, (_, i) => `refs/heads/${i}`);

  assert.ok(
    branchMenuRequest('delete-branches', {
      ...context,
      refId: refIds[0],
      refSelectionCount: refIds.length,
      refIds: refIds,
    }),
  );
});
