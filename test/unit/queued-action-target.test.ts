import { expect, test } from 'vitest';

import { QuerySession } from '../../src/extension/panel/queries';
import { queuedActionCurrent } from '../../src/extension/panel/queued-action';
import { a, b } from '../fixtures/controller';

test('a queued worktree starting at HEAD cannot adopt a different checkout', () => {
  const session = new QuerySession();

  session.repositoryInfo = {
    id: 'one',
    label: 'One',
    rootUri: 'file:///one',
    branch: 'main',
    headSha: a,
  };
  const current = queuedActionCurrent({ kind: 'create-worktree' }, session);

  expect(current()).toBe(true);
  session.repositoryInfo = {
    ...session.repositoryInfo,
    branch: 'other',
    headSha: b,
  };
  expect(current()).toBe(false);
});
