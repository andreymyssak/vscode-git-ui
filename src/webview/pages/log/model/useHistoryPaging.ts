import { useEffect, useRef } from 'react';

import type { HistoryData } from './selectors';
import type { LogIntent } from './view';

export function useHistoryPaging(
  data: HistoryData,
  viewportHeight: number,
  onIntent: (intent: LogIntent) => void,
) {
  const ownership = useRef<{
    key: string;
    attempt: {
      cursor: string;
      kind: 'requested' | 'loading' | 'settled';
    } | null;
  }>({ key: '', attempt: null });

  useEffect(() => {
    const key = `${data.repository?.id ?? ''}:${data.generation}`;

    if (ownership.current.key !== key)
      ownership.current = { key, attempt: null };
    const cursor = data.nextCursor;
    const current = ownership.current;
    const nearEnd =
      viewportHeight > 0 &&
      data.scrollTop + viewportHeight >=
        data.commits.length * 22 - Math.max(66, viewportHeight);

    if (current.attempt?.cursor === cursor) {
      if (data.loading) current.attempt.kind = 'loading';
      else if (current.attempt.kind === 'loading')
        current.attempt.kind = 'settled';
      // A deliberate new boundary crossing can retry a settled page. Merely
      // remaining near the end after a failure must not start a retry loop.
      if (!nearEnd && current.attempt.kind === 'settled')
        current.attempt = null;
    }

    if (
      !cursor ||
      data.loading ||
      !data.repository ||
      !data.commits.length ||
      !nearEnd ||
      current.attempt?.cursor === cursor
    )
      return;
    current.attempt = { cursor, kind: 'requested' };
    onIntent({
      kind: 'request',
      body: {
        kind: 'history',
        scope: data.scope,
        text: data.text,
        filters: data.filters,
        cursor,
      },
    });
  }, [
    data.repository,
    data.generation,
    data.nextCursor,
    data.loading,
    data.commits.length,
    data.scrollTop,
    data.scope,
    data.text,
    data.filters,
    viewportHeight,
    onIntent,
  ]);
}
