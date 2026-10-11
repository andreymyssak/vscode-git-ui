import { isAbsolute, win32 } from 'node:path';

import type { GitApiAccess } from './api';
import type { BlameQuery, BlameResult } from './blame-model';
import { parseBlamePorcelain } from './blame-porcelain';
import type { GitCli } from './cli';

function validateSource(query: BlameQuery): void {
  const { source } = query;
  const parts = source.path.split(process.platform === 'win32' ? /[\\/]/ : '/');

  if (
    !source.path ||
    source.path.includes('\0') ||
    isAbsolute(source.path) ||
    (process.platform === 'win32' && win32.isAbsolute(source.path)) ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Select a file inside the Git repository.');
  const sha = source.kind === 'revision' ? source.sha : source.headSha;

  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha))
    throw new Error('Blame requires a full commit identity.');
}

function unborn(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 1 &&
    'stdout' in error &&
    error.stdout === '' &&
    'stderr' in error &&
    error.stderr === ''
  );
}

export function createBlameQueries(
  access: GitApiAccess,
  cli: Pick<GitCli, 'run' | 'runWithInput'>,
): (query: BlameQuery, signal?: AbortSignal) => Promise<BlameResult> {
  return async (query, signal) => {
    signal?.throwIfAborted();
    validateSource(query);
    access.repository(query.repositoryId);
    const args = ['blame', '--encoding=UTF-8', '--line-porcelain', '--root'];

    if (query.ignoreWhitespace) args.push('-w');
    const { source, repositoryId } = query;
    let output: string;

    if (source.kind === 'revision') {
      output = await cli.run(
        repositoryId,
        [...args, source.sha, '--', source.path],
        signal,
      );
    } else {
      const readHead = () =>
        cli.run(
          repositoryId,
          ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
          signal,
        );
      const checkHead = (head: string) => {
        if (head.trim() !== source.headSha)
          throw new DOMException(
            'Git HEAD changed while reading blame.',
            'AbortError',
          );
      };

      let head: string;

      try {
        head = await readHead();
      } catch (error) {
        if (unborn(error)) return { kind: 'no-history' };
        throw error;
      }

      checkHead(head);
      const tracked = await cli.run(
        repositoryId,
        [
          'ls-tree',
          '--name-only',
          '-z',
          source.headSha,
          '--',
          `:(literal)${source.path}`,
        ],
        signal,
      );

      if (!tracked) return { kind: 'no-history' };
      output = await cli.runWithInput(
        repositoryId,
        [...args, '--contents', '-', '--', source.path],
        source.contents,
        signal,
      );
      checkHead(await readHead());
    }

    signal?.throwIfAborted();
    access.repository(repositoryId);

    return { kind: 'blame', lines: parseBlamePorcelain(output) };
  };
}
