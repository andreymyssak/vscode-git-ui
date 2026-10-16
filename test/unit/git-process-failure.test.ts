import { expect, test } from 'vitest';

import {
  GitProcessFailure,
  gitProcessOutputLimit,
  normalizeGitProcessFailure,
} from '../../src/extension/git/process-failure';

test.each(['AbortError', 'TimeoutError'])(
  '%s identity survives process normalization',
  (name) => {
    const reason = new DOMException('The caller owns this reason.', name);

    expect(normalizeGitProcessFailure(reason)).toBe(reason);
  },
);

test.each([
  { code: 'EACCES', reason: 'permission-denied' },
  { code: 'EPERM', reason: 'permission-denied' },
  { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', reason: 'output-limit' },
])('process code $code has stable reason $reason', ({ code, reason }) => {
  const cause = Object.assign(new Error('Original process failure'), { code });

  expect(normalizeGitProcessFailure(cause)).toMatchObject({
    reason,
    code,
    signal: null,
    stdout: '',
    stderr: '',
    cause,
  });
});

test('unknown process failures keep a useful fallback and their original cause', () => {
  const cause = Object.assign(
    new Error('The executable could not be loaded.'),
    {
      code: 'EUNRECOGNIZED',
    },
  );
  const error = normalizeGitProcessFailure(cause);

  expect(error).toMatchObject({
    name: 'GitProcessFailure',
    reason: 'unknown',
    code: 'EUNRECOGNIZED',
    signal: null,
    stdout: '',
    stderr: '',
    message: cause.message,
    cause,
  });
  expect(normalizeGitProcessFailure(error)).toBe(error);
  expect(normalizeGitProcessFailure('Unknown execution failure')).toMatchObject(
    {
      reason: 'unknown',
      message: 'Unknown execution failure',
      cause: 'Unknown execution failure',
    },
  );
  expect(normalizeGitProcessFailure(undefined)).toMatchObject({
    message: 'Running Git failed.',
    code: null,
    signal: null,
  });
});

test('retained stdout, stderr and the displayed failure stay bounded', () => {
  const cause = new Error('Process failed');
  const error = normalizeGitProcessFailure(cause, {
    code: 7,
    stdout: 'o'.repeat(gitProcessOutputLimit + 10),
    stderr: 'e'.repeat(gitProcessOutputLimit + 10),
  });

  expect(error).toBeInstanceOf(GitProcessFailure);
  expect(error).toMatchObject({
    stdout: 'o'.repeat(gitProcessOutputLimit),
    stderr: 'e'.repeat(gitProcessOutputLimit),
    message: 'e'.repeat(gitProcessOutputLimit),
    cause,
  });
});
