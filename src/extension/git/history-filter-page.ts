import { dateBounds } from '../../shared/date-filter';
import type {
  AuthorIdentity,
  CommitRecord,
  HistoryFilters,
} from '../../shared/model';
import { classifySearch } from '../../shared/search';
import { isRecord } from '../../shared/validation';
import type { GitCli } from './cli';
import {
  historyCommit,
  historyFields,
  isHistoryObjectId,
  restoreHistoryParents,
} from './history-records';
import { readUserIdentity } from './identity';

export interface PreparedHistoryFilter {
  readonly tips: readonly string[];
  readonly args: readonly string[];
  readonly authors: readonly AuthorIdentity[] | null;
  readonly from: number;
  readonly until: number;
  readonly hashPrefix: string | null;
  readonly text: string;
  readonly matchCase: boolean;
}

export async function prepareHistoryFilter(
  cli: GitCli,
  id: string,
  input: {
    tips: readonly string[];
    text: string;
    filters: HistoryFilters;
    now: number;
  },
  signal?: AbortSignal,
): Promise<PreparedHistoryFilter> {
  signal?.throwIfAborted();
  const { filters, text } = input;

  if (text.includes('\0') || !input.tips.every(isHistoryObjectId))
    throw new Error('Invalid history query.');
  let authors: AuthorIdentity[] | null = null;

  if (filters.author.kind === 'selected')
    authors = filters.author.identities.map((identity) => ({ ...identity }));
  if (filters.author.kind === 'me') {
    const user = await readUserIdentity(cli, id, signal);

    if (!user)
      throw new Error(
        'Configure your Git identity (user.email or user.name) to use Me.',
      );
    authors = [user];
  }

  const [from, until] = dateBounds(filters.date, input.now);
  const hashPrefix =
    !filters.regex && classifySearch(text) === 'hash-and-text'
      ? text.toLowerCase()
      : null;
  const args = [
    'log',
    '--topo-order',
    '--no-color',
    '--no-decorate',
    '--no-notes',
    '--no-show-signature',
    '--no-use-mailmap',
    '--encoding=UTF-8',
    '-z',
    '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%B',
    filters.regex ? '--extended-regexp' : '--fixed-strings',
    ...(filters.matchCase ? [] : ['--regexp-ignore-case']),
    ...(text && !hashPrefix ? [`--grep=${text}`] : []),
  ];

  // --since prunes at old descendants. Exact lower bounds stay in the stream.
  if (Number.isFinite(until))
    args.push(`--until=@${Math.ceil(until / 1000) - 1}`);
  for (const author of authors ?? []) {
    const value = author.email || author.name;
    const pattern = filters.regex
      ? value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
      : value;

    args.push(`--author=${pattern}`);
  }

  return {
    tips: [...input.tips],
    args,
    authors,
    from,
    until,
    hashPrefix,
    text,
    matchCase: filters.matchCase,
  };
}

export async function readFilteredHistoryPage(
  cli: GitCli,
  id: string,
  query: PreparedHistoryFilter,
  offset: number,
  signal?: AbortSignal,
): Promise<{ commits: CommitRecord[]; nextOffset: number | null }> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Invalid history position.');
  const commits: CommitRecord[] = [];
  let position = offset;
  let nextOffset: number | null = null;
  const fields = historyFields(7, (values) => {
    const commit = historyCommit(values);
    const committedAt = Date.parse(commit.commitDate ?? '');
    const candidate = position++;
    const identityMatches =
      query.authors === null ||
      query.authors.some((author) =>
        author.email
          ? author.email === commit.authorEmail
          : author.name === commit.authorName,
      );
    const unionMatches =
      query.hashPrefix === null ||
      commit.sha.toLowerCase().startsWith(query.hashPrefix) ||
      (query.matchCase
        ? commit.message
        : commit.message.toLowerCase()
      ).includes(query.matchCase ? query.text : query.text.toLowerCase());

    if (
      committedAt < query.from ||
      committedAt >= query.until ||
      !identityMatches ||
      !unionMatches
    )
      return true;
    if (commits.length === 200) {
      nextOffset = candidate;

      return false;
    }

    commits.push(commit);

    return true;
  });

  if (!query.tips.length) return { commits, nextOffset };
  try {
    await cli.stream(
      id,
      [...query.args, `--skip=${offset}`, '--stdin', '--'],
      fields.write,
      signal,
      query.tips.join('\n') + '\n',
    );
    fields.finish();
  } catch (error) {
    const detail =
      isRecord(error) && typeof error.stderr === 'string'
        ? error.stderr
        : String(error);

    if (
      query.args.includes('--extended-regexp') &&
      /Unmatched|Invalid.*regexp|Invalid.*regular|invalid.*expression|not balanced|trailing backslash|repetition-operator/i.test(
        detail,
      )
    )
      throw new Error(
        'Invalid regular expression. Check the pattern and try again.',
        { cause: error },
      );
    throw error;
  }

  await restoreHistoryParents(cli, id, commits, signal);

  return { commits, nextOffset };
}
