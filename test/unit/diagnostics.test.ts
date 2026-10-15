import { expect, test, vi } from 'vitest';

import {
  diagnostics,
  installDiagnostics,
} from '../../src/extension/diagnostics';
import { SourceControlModel } from '../../src/extension/source-control/model';

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test('diagnostic metadata correlates repositories without logging paths or error text', () => {
  const write = vi.fn();
  const installed = installDiagnostics(write);

  try {
    diagnostics.record('read.finished', {
      repositoryId: 'file:///secret/customer',
      requestId: 'private-search',
      elapsedMs: 12,
      outcome: 'error',
      error: new Error('token=secret-message'),
    });
    diagnostics.record('read.finished', {
      repositoryId: 'file:///secret/customer',
      outcome: 'success',
    });
    const logged = JSON.stringify(write.mock.calls);

    expect(logged).not.toMatch(/customer|private-search|token|secret-message/);
    const entries = write.mock.calls.map(([, value]) => JSON.parse(value));

    expect(entries[0].repository).toBe(entries[1].repository);
    expect(entries[0]).toMatchObject({
      event: 'read.finished',
      elapsedMs: 12,
      outcome: 'error',
      errorKind: 'Error',
    });
  } finally {
    installed.dispose();
  }

  diagnostics.record('read.finished', { outcome: 'success' });
  expect(write).toHaveBeenCalledTimes(2);
});

test('a broken diagnostic destination cannot break product operations', () => {
  const installed = installDiagnostics(() => {
    throw new Error('closed channel');
  });

  try {
    expect(() =>
      diagnostics.record('read.finished', { outcome: 'success' }),
    ).not.toThrow();
  } finally {
    installed.dispose();
  }
});

test('draft persistence failures are deduplicated, recover, and never discard the current edit', async () => {
  const write = vi.fn();
  const installed = installDiagnostics(write);
  let broken = true;
  const stored: unknown[] = [];
  const model = new SourceControlModel({
    get: () => undefined,
    update: async (_key, value) => {
      if (broken) throw new Error('sensitive draft must not be logged');
      stored.push(value);
    },
  });

  try {
    model.setDraft('repo', 'first');
    await flush();
    model.setDraft('repo', 'second');
    await flush();
    expect(model.draft('repo')).toBe('second');
    expect(write).toHaveBeenCalledTimes(1);
    broken = false;
    model.setDraft('repo', 'latest');
    await flush();
    expect(stored.at(-1)).toEqual([
      { repositoryId: 'repo', message: 'latest' },
    ]);
    expect(write).toHaveBeenCalledTimes(2);
    broken = true;
    model.setDraft('repo', 'after recovery');
    await flush();
    expect(write).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(write.mock.calls)).not.toMatch(
      /sensitive|first|second|latest|after recovery/,
    );
  } finally {
    installed.dispose();
  }
});
