import { isRecord } from '../../shared/validation';

export const gitProcessOutputLimit = 65_536;

interface ProcessDetails {
  code: number | string | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

type ProcessFailureReason =
  | 'exit'
  | 'signal'
  | 'not-found'
  | 'permission-denied'
  | 'output-limit'
  | 'unknown';

function failureReason({ code, signal }: ProcessDetails): ProcessFailureReason {
  if (code === 'ENOENT') return 'not-found';
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied';
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-limit';
  if (signal !== null) return 'signal';
  if (typeof code === 'number') return 'exit';

  return 'unknown';
}

function failureMessage(
  reason: ProcessFailureReason,
  details: ProcessDetails,
  cause: unknown,
): string {
  if (details.stderr.trim()) return details.stderr.trim();
  switch (reason) {
    case 'not-found':
      return 'Git executable was not found.';
    case 'permission-denied':
      return 'Git executable could not be started. Check its permissions.';
    case 'output-limit':
      return 'Git output exceeded the buffer limit.';
    case 'signal':
      return `Git was terminated by ${String(details.signal)}.`;
    case 'exit':
      return `Git exited with status ${String(details.code)}.`;
    case 'unknown':
      return cause instanceof Error && cause.message
        ? cause.message
        : typeof cause === 'string' && cause
          ? cause
          : 'Running Git failed.';
    default: {
      const exhaustive: never = reason;

      return exhaustive;
    }
  }
}

/** Transport data stays private to the host; diagnostics never record its text. */
export class GitProcessFailure extends Error {
  readonly code: ProcessDetails['code'];
  readonly signal: ProcessDetails['signal'];
  readonly stdout: string;
  readonly stderr: string;
  readonly reason: ProcessFailureReason;

  constructor(cause: unknown, details: ProcessDetails) {
    const bounded = {
      ...details,
      stdout: details.stdout.slice(0, gitProcessOutputLimit),
      stderr: details.stderr.slice(0, gitProcessOutputLimit),
    };
    const reason = failureReason(bounded);

    super(failureMessage(reason, bounded, cause), { cause });
    this.name = 'GitProcessFailure';
    this.code = bounded.code;
    this.signal = bounded.signal;
    this.stdout = bounded.stdout;
    this.stderr = bounded.stderr;
    this.reason = reason;
  }
}

/** Only call at process boundaries, so domain and consumer failures stay intact. */
export function normalizeGitProcessFailure(
  cause: unknown,
  details: Partial<ProcessDetails> = {},
): Error {
  if (
    cause instanceof GitProcessFailure ||
    (cause instanceof Error &&
      (cause.name === 'AbortError' || cause.name === 'TimeoutError'))
  )
    return cause;

  const source = isRecord(cause) ? cause : {};

  return new GitProcessFailure(cause, {
    code:
      details.code !== undefined
        ? details.code
        : typeof source.code === 'number' || typeof source.code === 'string'
          ? source.code
          : null,
    signal:
      details.signal !== undefined
        ? details.signal
        : typeof source.signal === 'string'
          ? source.signal
          : null,
    stdout:
      details.stdout ??
      (typeof source.stdout === 'string' ? source.stdout : ''),
    stderr:
      details.stderr ??
      (typeof source.stderr === 'string' ? source.stderr : ''),
  });
}
