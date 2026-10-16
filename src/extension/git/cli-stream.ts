import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { readCancellationError } from '../read-cancellation';
import {
  gitProcessOutputLimit,
  normalizeGitProcessFailure,
} from './process-failure';

/** A false consumer result stops the read. Every exit path awaits process close. */
export function executeStream(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  consume: (chunk: Buffer) => boolean,
  input?: string | Buffer,
): Promise<void> {
  options.signal?.throwIfAborted();

  return new Promise<void>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;

    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(normalizeGitProcessFailure(error));

      return;
    }

    let stopped = false;
    let terminated = false;
    let failure:
      | { kind: 'process' | 'cancelled'; cause: Error }
      | { kind: 'consumer'; cause: unknown }
      | undefined;
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      terminated = child.kill();
      if (terminated) {
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        killTimer.unref();
      }
    };

    const abort = () => {
      failure = {
        kind: 'cancelled',
        cause: readCancellationError(options.signal?.reason),
      };
      stop();
    };

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += stdoutDecoder
        .write(chunk)
        .slice(0, gitProcessOutputLimit - stdout.length);
      if (stopped) return;
      try {
        if (!consume(chunk)) stop();
      } catch (error) {
        failure = { kind: 'consumer', cause: error };
        stop();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep diagnostics bounded even if a failing executable is noisy.
      stderr += stderrDecoder
        .write(chunk)
        .slice(0, gitProcessOutputLimit - stderr.length);
    });
    child.on('error', (error) => {
      failure ??= { kind: 'process', cause: error };
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // Match buffered execution: the child's exit owns a closed input pipe.
      if (error.code === 'EPIPE') return;
      failure ??= { kind: 'process', cause: error };
      stop();
    });
    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      stdout += stdoutDecoder
        .end()
        .slice(0, gitProcessOutputLimit - stdout.length);
      stderr += stderrDecoder
        .end()
        .slice(0, gitProcessOutputLimit - stderr.length);
      const details = { code, signal, stdout, stderr };

      if (failure?.kind === 'consumer') {
        // The consumer owns its thrown value, including values outside Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(failure.cause);
      } else if (failure !== undefined)
        reject(
          failure.kind === 'process'
            ? normalizeGitProcessFailure(failure.cause, {
                stdout,
                stderr,
              })
            : failure.cause,
        );
      else if (
        code === 0 ||
        (terminated && (signal === 'SIGTERM' || signal === 'SIGKILL'))
      )
        resolve();
      else reject(normalizeGitProcessFailure(undefined, details));
    });
    child.stdin.end(input);
  });
}
