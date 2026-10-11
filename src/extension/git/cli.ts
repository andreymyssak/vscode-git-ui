import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import type { GitApiAccess } from './api';
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
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { ...options, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error instanceof Error)
          reject(
            Object.assign(error, {
              stdout: stdout.toString('utf8'),
              stderr: stderr.toString('utf8'),
            }),
          );
        else resolve(stdout);
      },
    );

    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin?.end(input);
  });
}

export class GitCli {
  constructor(private readonly access: GitApiAccess) {}

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
    execution.signal?.throwIfAborted();
    const repository = this.access.repository(repositoryId);
    const cwd = await realpath(repository.rootUri.fsPath);
    const options = {
      cwd,
      env: environment(),
      ...(execution.signal ? { signal: execution.signal } : {}),
    };
    const top = (
      await execute(
        this.access.api.git.path,
        ['rev-parse', '--show-toplevel'],
        options,
      )
    )
      .toString('utf8')
      .trim();
    const canonical = (path: string) =>
      process.platform === 'win32'
        ? normalize(path).toLowerCase()
        : normalize(path);

    if (canonical(await realpath(top)) !== canonical(cwd))
      throw new Error('Repository root changed. Refresh before trying again.');
    this.access.repository(repositoryId);
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
}
