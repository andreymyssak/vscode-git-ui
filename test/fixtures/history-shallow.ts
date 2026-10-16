import type { HistoryShallow } from '../../src/extension/git/history-shallow';

/** A controlled metadata reader for history tests with in-memory Git objects. */
export const completeHistoryShallow: HistoryShallow = {
  path: async () => '/fixture/shallow',
  identity: async () => 'complete',
  invalidate() {},
  dispose() {},
};
