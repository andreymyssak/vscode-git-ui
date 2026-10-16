import type { AuthorIdentity } from '../../shared/model';
import type { GitCli } from './cli';
import { historyFields, isHistoryObjectId } from './history-records';

export async function readAuthors(
  cli: GitCli,
  id: string,
  tips: string[],
  signal?: AbortSignal,
): Promise<AuthorIdentity[]> {
  signal?.throwIfAborted();
  if (!tips.length) return [];
  if (!tips.every(isHistoryObjectId)) throw new Error('Invalid history scope.');
  const authors = new Map<string, AuthorIdentity>();
  const fields = historyFields(2, ([name, email]) => {
    if (name === undefined || email === undefined)
      throw new Error('Git returned incomplete author metadata.');
    const identity = { name, email };

    if (name || email) authors.set(JSON.stringify(identity), identity);

    return true;
  });

  await cli.stream(
    id,
    [
      'log',
      '--topo-order',
      '--no-color',
      '--no-decorate',
      '--no-notes',
      '--no-show-signature',
      '--encoding=UTF-8',
      '-z',
      '--format=%an%x00%ae',
      '--stdin',
      '--',
    ],
    fields.write,
    signal,
    tips.join('\n') + '\n',
  );
  fields.finish();

  return [...authors.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email),
  );
}
