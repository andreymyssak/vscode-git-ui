import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import { diagnostics } from '../diagnostics';
import { readCancellationError } from '../read-cancellation';
import type { GitApiAccess } from './api';
import { backgroundRead, backgroundReadTimeoutMs } from './background-read';
import { executeStream } from './cli-stream';
import { normalizeGitProcessFailure } from './process-failure';
import type { SquashEditors } from './squash-editor';

interface Execution {
  input?: string | Buffer;
  signal?: AbortSignal;
  beforeExecute?: () => void | Promise<void>;
  editors?: SquashEditors;
  index?: string;
}

export interface PrivateIndex {
  run(args: readonly string[], input?: string): Promise<string>;
}

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };

  // A VS Code process may inherit another Git invocation's repository routing.
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_NAMESPACE',
    'GIT_SHALLOW_FILE',
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ]) {
    delete env[key];
  }

  return env;
}

function execute(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  input?: string | Buffer,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { ...options, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error instanceof Error)
          reject(
            normalizeGitProcessFailure(error, {
              stdout: stdout.toString('utf8'),
              stderr: stderr.toString('utf8'),
            }),
          );
        else resolve(stdout);
      },
    );

    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(normalizeGitProcessFailure(error));
    });
    child.stdin?.end(input);
  }).catch((error: unknown) => {
    throw normalizeGitProcessFailure(error);
  });
}

export class GitCli {
  constructor(
    private readonly access: GitApiAccess,
    private readonly readOwner?: {
      signal: AbortSignal | undefined;
      timeoutMs: number;
    },
  ) {}

  /** Explicit opt-in: mutating calls keep the original unbounded writer instance. */
  readOnly(
    signal?: AbortSignal,
    timeoutMs = this.readOwner?.timeoutMs ?? backgroundReadTimeoutMs,
  ): GitCli {
    const inherited = this.readOwner?.signal;

    return new GitCli(this.access, {
      signal:
        inherited && signal
          ? AbortSignal.any([inherited, signal])
          : (inherited ?? signal),
      timeoutMs,
    });
  }

  get executablePath(): string {
    return this.access.api.git.path;
  }

  run(
    repositoryId: string,
    args: readonly string[],
    signal?: AbortSignal,
    beforeExecute?: () => void | Promise<void>,
    editors?: SquashEditors,
  ): Promise<string> {
    return this.execute(repositoryId, args, {
      ...(signal ? { signal } : {}),
      ...(beforeExecute ? { beforeExecute } : {}),
      ...(editors ? { editors } : {}),
    });
  }

  runWithInput(
    repositoryId: string,
    args: readonly string[],
    input: string | Buffer,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.execute(repositoryId, args, {
      input,
      ...(signal ? { signal } : {}),
    });
  }

  runBytes(
    repositoryId: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return this.executeBytes(repositoryId, args, {
      ...(signal ? { signal } : {}),
    });
  }

  runBytesWithInput(
    repositoryId: string,
    args: readonly string[],
    input: Buffer,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return this.executeBytes(repositoryId, args, {
      input,
      ...(signal ? { signal } : {}),
    });
  }

  async stream(
    repositoryId: string,
    args: readonly string[],
    consume: (chunk: Buffer) => boolean,
    signal?: AbortSignal,
    input?: string | Buffer,
    beforeExecute?: () => void | Promise<void>,
  ): Promise<void> {
    const started = performance.now();
    const inherited = this.readOwner?.signal;
    const deadline = new AbortController();
    const signals = [inherited, signal, deadline.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const owner = AbortSignal.any(signals);
    const timer = this.readOwner
      ? setTimeout(
          () =>
            deadline.abort(
              new DOMException(
                'Reading Git took too long. Refresh to try again.',
                'TimeoutError',
              ),
            ),
          this.readOwner.timeoutMs,
        )
      : undefined;

    timer?.unref();
    diagnostics.record('command.started', { repositoryId, command: args[0] });
    try {
      const options = await this.repositoryOptions(repositoryId, owner);

      owner.throwIfAborted();
      await beforeExecute?.();
      owner.throwIfAborted();
      await executeStream(this.executablePath, args, options, consume, input);
      owner.throwIfAborted();
      diagnostics.record('command.finished', {
        repositoryId,
        command: args[0],
        outcome: 'success',
        elapsedMs: performance.now() - started,
      });
    } catch (error) {
      diagnostics.record('command.finished', {
        repositoryId,
        command: args[0],
        outcome: owner.aborted ? 'cancelled' : 'error',
        error,
        elapsedMs: performance.now() - started,
      });
      throw owner.aborted ? readCancellationError(owner.reason) : error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async withTemporaryIndex<T>(
    repositoryId: string,
    callback: (index: PrivateIndex) => Promise<T>,
  ): Promise<T> {
    this.access.repository(repositoryId);
    const directory = await mkdtemp(join(tmpdir(), 'git-ui-index-'));

    try {
      return await callback({
        run: (args, input) =>
          this.execute(repositoryId, args, {
            index: join(directory, 'index'),
            ...(input === undefined ? {} : { input }),
          }),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async execute(
    repositoryId: string,
    args: readonly string[],
    execution: Execution,
  ): Promise<string> {
    return (await this.executeBytes(repositoryId, args, execution)).toString(
      'utf8',
    );
  }

  private async executeBytes(
    repositoryId: string,
    args: readonly string[],
    execution: Execution,
  ): Promise<Buffer> {
    const started = performance.now();

    diagnostics.record('command.started', { repositoryId, command: args[0] });
    try {
      const inherited = this.readOwner?.signal;
      const requested = execution.signal;
      const signal =
        inherited && requested
          ? AbortSignal.any([inherited, requested])
          : (inherited ?? requested);
      const result = this.readOwner
        ? await backgroundRead(
            (owner) =>
              this.executeChecked(repositoryId, args, {
                ...execution,
                signal: owner,
              }),
            signal,
            this.readOwner.timeoutMs,
          )
        : await this.executeChecked(repositoryId, args, execution);

      diagnostics.record('command.finished', {
        repositoryId,
        command: args[0],
        outcome: 'success',
        elapsedMs: performance.now() - started,
      });

      return result;
    } catch (error) {
      diagnostics.record('command.finished', {
        repositoryId,
        command: args[0],
        outcome: execution.signal?.aborted ? 'cancelled' : 'error',
        error,
        elapsedMs: performance.now() - started,
      });
      throw error;
    }
  }

  private async executeChecked(
    repositoryId: string,
    args: readonly string[],
    execution: Execution,
  ): Promise<Buffer> {
    const options = await this.repositoryOptions(
      repositoryId,
      execution.signal,
    );

    await execution.beforeExecute?.();
    const result = await execute(
      this.access.api.git.path,
      args,
      {
        ...options,
        env: {
          ...options.env,
          ...(execution.index ? { GIT_INDEX_FILE: execution.index } : {}),
          ...execution.editors,
        },
      },
      execution.input,
    );

    execution.signal?.throwIfAborted();

    return result;
  }

  private async repositoryOptions(repositoryId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const repository = this.access.repository(repositoryId);
    const cwd = await realpath(repository.rootUri.fsPath);
    const options = {
      cwd,
      env: environment(),
      ...(signal ? { signal } : {}),
    };
    const top = (
      await execute(
        this.access.api.git.path,
        ['rev-parse', '--show-toplevel'],
        options,
      )
    )
      .toString('utf8')
      .replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
    const canonical = (path: string) =>
      process.platform === 'win32'
        ? normalize(path).toLowerCase()
        : normalize(path);

    if (canonical(await realpath(top)) !== canonical(cwd))
      throw new Error('Repository root changed. Refresh before trying again.');
    this.access.repository(repositoryId);

    return options;
  }
}
