import { isAbsolute, win32 } from 'node:path';

import type { GitApiAccess } from './api';
import { decodeBlamePorcelain, utf8BlameCodec } from './blame-bytes';
import type { BlameQuery, BlameResult, BlameTextCodec } from './blame-model';
import { parseBlamePorcelain } from './blame-porcelain';
import { type GitCapabilityCli, readGitCapabilities } from './capabilities';
import type { GitCli } from './cli';

const sourceEncodingRequirement =
  'Annotating non-UTF-8 historical files requires Git 2.40 or newer to check source encoding attributes.';

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

async function checkSourceEncoding(
  query: BlameQuery,
  cli: GitCapabilityCli,
  signal?: AbortSignal,
): Promise<void> {
  const revision = query.source.kind === 'revision';

  if (
    revision &&
    ['utf8', 'utf8bom', 'utf-8'].includes(query.encoding ?? 'utf8')
  )
    return;
  if (
    revision &&
    !(await readGitCapabilities(cli, query.repositoryId, signal))
      .checkAttributeSource
  )
    throw new Error(sourceEncodingRequirement);
  let attributes: string;

  try {
    attributes = await cli.run(
      query.repositoryId,
      [
        'check-attr',
        '-z',
        ...(query.source.kind === 'revision'
          ? [`--source=${query.source.sha}`]
          : []),
        'working-tree-encoding',
        '--',
        query.source.path,
      ],
      signal,
    );
  } catch (error) {
    if (
      revision &&
      error instanceof Error &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /(?:unknown|unrecognized) (?:option|switch).*source/i.test(error.stderr)
    )
      throw new Error(sourceEncodingRequirement, { cause: error });
    throw error;
  }

  const [path, name, value, ending, extra] = attributes.split('\0');

  if (
    path !== query.source.path ||
    name !== 'working-tree-encoding' ||
    value === undefined ||
    ending !== '' ||
    extra !== undefined
  )
    throw new Error('Git returned invalid file encoding attributes.');
  if (value !== 'unspecified' && value !== 'unset')
    throw new Error(
      'Git blame does not support files transformed by working-tree-encoding.',
    );
}

export function createBlameQueries(
  access: GitApiAccess,
  cli: GitCapabilityCli & Pick<GitCli, 'runBytes' | 'runBytesWithInput'>,
  codec: BlameTextCodec = utf8BlameCodec,
): (query: BlameQuery, signal?: AbortSignal) => Promise<BlameResult> {
  return async (query, signal) => {
    signal?.throwIfAborted();
    validateSource(query);
    access.repository(query.repositoryId);
    const args = ['blame', '--encoding=UTF-8', '--line-porcelain', '--root'];

    if (query.ignoreWhitespace) args.push('-w');
    const { source, repositoryId } = query;
    const encoding = query.encoding ?? 'utf8';
    let output: Buffer;
    let pathInHead = true;

    if (source.kind === 'revision') {
      await checkSourceEncoding(query, cli, signal);
      output = await cli.runBytes(
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

      pathInHead = Boolean(tracked);
      if (
        !pathInHead &&
        !(await cli.run(
          repositoryId,
          ['ls-files', '--cached', '-z', '--', `:(literal)${source.path}`],
          signal,
        ))
      )
        return { kind: 'no-history' };
      await checkSourceEncoding(query, cli, signal);
      const input = Buffer.from(await codec.encode(source.contents, encoding));

      signal?.throwIfAborted();
      output = await cli.runBytesWithInput(
        repositoryId,
        [...args, '--contents', '-', '--', source.path],
        input,
        signal,
      );
      checkHead(await readHead());
    }

    signal?.throwIfAborted();
    access.repository(repositoryId);

    const lines = parseBlamePorcelain(
      await decodeBlamePorcelain(output, codec, encoding),
    );

    signal?.throwIfAborted();

    if (!pathInHead && !lines.some((line) => line.kind === 'committed'))
      return { kind: 'no-history' };

    return { kind: 'blame', lines };
  };
}
