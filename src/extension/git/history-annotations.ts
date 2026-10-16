import type { CommitRecord } from '../../shared/model';
import { readCancellationError } from '../read-cancellation';
import type { GitCli } from './cli';
import { isHistoryObjectId } from './history-records';

const retainedAncestors = 4000;
const retainedAnswers = 4000;
const retainedSnapshots = 20;

interface MembershipInput {
  snapshot: symbol;
  repositoryId: string;
  head: string | null;
  tips: readonly string[];
  commits: readonly CommitRecord[];
  signal?: AbortSignal;
}

interface Request {
  wanted: Set<string>;
  found: Set<string>;
  finish(error?: Error): void;
}

interface Walk {
  owner: AbortController;
  requests: Set<Request>;
  accepting: boolean;
}

interface Snapshot {
  repositoryId: string;
  head: string;
  prefix: Set<string>;
  answers: Map<string, boolean>;
  waiting: Set<Request>;
  walk: Walk | null;
  disposed: boolean;
}

/** Share ancestry reads, retaining a bounded prefix and answers rather than the full walk. */
export function createHistoryAnnotations(reader: GitCli) {
  const snapshots = new Map<symbol, Snapshot>();
  let disposed = false;
  const remember = (snapshot: Snapshot, sha: string, reachable: boolean) => {
    snapshot.answers.delete(sha);
    snapshot.answers.set(sha, reachable);
    if (snapshot.answers.size > retainedAnswers)
      snapshot.answers.delete(snapshot.answers.keys().next().value!);
  };

  const retire = (snapshot: Snapshot) => {
    snapshot.disposed = true;
    snapshot.walk?.owner.abort();
    const error = new DOMException(
      'The ancestry read was cancelled.',
      'AbortError',
    );

    for (const request of [
      ...snapshot.waiting,
      ...(snapshot.walk?.requests ?? []),
    ])
      request.finish(error);
    snapshot.prefix.clear();
    snapshot.answers.clear();
  };

  const start = (snapshot: Snapshot) => {
    if (snapshot.disposed || snapshot.walk || !snapshot.waiting.size) return;
    const walk: Walk = {
      owner: new AbortController(),
      requests: new Set(snapshot.waiting),
      accepting: true,
    };

    snapshot.waiting.clear();
    snapshot.walk = walk;
    void Promise.resolve().then(async () => {
      let pending = '';
      let stopped = false;
      let visited = 0;
      const line = (sha: string) => {
        if (!isHistoryObjectId(sha))
          throw new Error('Git returned invalid branch ancestry.');
        visited++;
        if (snapshot.prefix.size < retainedAncestors) snapshot.prefix.add(sha);
        // Later subscribers cannot recover records already passed beyond the prefix.
        if (visited >= retainedAncestors) walk.accepting = false;
        for (const request of walk.requests) {
          if (!request.wanted.delete(sha)) continue;
          request.found.add(sha);
          if (!request.wanted.size) request.finish();
        }

        return (
          snapshot.prefix.size < retainedAncestors || walk.requests.size > 0
        );
      };

      try {
        await reader.readOnly(walk.owner.signal).stream(
          snapshot.repositoryId,
          ['rev-list', snapshot.head, '--'],
          (chunk) => {
            const text = pending + chunk.toString('utf8');
            let begin = 0;

            for (
              let end = text.indexOf('\n');
              end !== -1;
              end = text.indexOf('\n', begin)
            ) {
              const value = text.slice(begin, end).replace(/\r$/, '');

              begin = end + 1;
              if (!line(value)) {
                stopped = true;
                walk.accepting = false;

                return false;
              }
            }

            pending = text.slice(begin);
            if (pending.length > 64)
              throw new Error('Git returned invalid branch ancestry.');

            return true;
          },
          walk.owner.signal,
        );
        if (snapshot.disposed || walk.owner.signal.aborted) return;
        walk.accepting = false;
        if (!stopped) {
          if (pending) line(pending);
          for (const request of walk.requests) request.finish();
        }
      } catch (error) {
        walk.accepting = false;
        const failure = readCancellationError(error);

        snapshot.prefix.clear();
        snapshot.answers.clear();
        for (const request of walk.requests) request.finish(failure);
      } finally {
        if (snapshot.walk === walk) snapshot.walk = null;
        // A successor waits for the old CLI process to release its ownership.
        if (!snapshot.disposed) start(snapshot);
      }
    });
  };

  return {
    async read({
      snapshot: key,
      repositoryId,
      head,
      tips,
      commits,
      signal,
    }: MembershipInput): Promise<string[]> {
      signal?.throwIfAborted();
      if (disposed)
        throw new DOMException(
          'History annotations are disposed.',
          'AbortError',
        );
      if (!head || !commits.length) return [];
      if (
        !isHistoryObjectId(head) ||
        commits.some((commit) => !isHistoryObjectId(commit.sha))
      )
        throw new Error('Invalid branch ancestry query.');
      if (tips.length === 1 && tips[0] === head)
        return commits.map((commit) => commit.sha);
      let snapshot = snapshots.get(key);

      if (
        snapshot &&
        (snapshot.repositoryId !== repositoryId || snapshot.head !== head)
      ) {
        snapshots.delete(key);
        retire(snapshot);
        snapshot = undefined;
      }

      if (!snapshot) {
        snapshot = {
          repositoryId,
          head,
          prefix: new Set(),
          answers: new Map(),
          waiting: new Set(),
          walk: null,
          disposed: false,
        };
        snapshots.set(key, snapshot);
        if (snapshots.size > retainedSnapshots) {
          const oldest = snapshots.keys().next().value!;
          const evicted = snapshots.get(oldest);

          snapshots.delete(oldest);
          if (evicted) retire(evicted);
        }
      } else {
        snapshots.delete(key);
        snapshots.set(key, snapshot);
      }

      const current = snapshot;
      const shas = commits.map((commit) => commit.sha);
      const found = new Set(
        shas.filter(
          (sha) => current.prefix.has(sha) || current.answers.get(sha) === true,
        ),
      );
      const wanted = new Set(
        shas.filter((sha) => !found.has(sha) && !current.answers.has(sha)),
      );

      if (!wanted.size) return shas.filter((sha) => found.has(sha));

      return new Promise((resolve, reject) => {
        let settled = false;
        const request: Request = {
          wanted,
          found,
          finish(error) {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', cancel);
            current.waiting.delete(request);
            current.walk?.requests.delete(request);
            if (error) reject(error);
            else {
              for (const sha of shas) remember(current, sha, found.has(sha));
              resolve(shas.filter((sha) => found.has(sha)));
            }
          },
        };
        const cancel = () => {
          request.finish(readCancellationError(signal?.reason));
          if (!current.walk?.requests.size && !current.waiting.size)
            current.walk?.owner.abort();
        };

        signal?.addEventListener('abort', cancel, { once: true });
        if (current.walk?.accepting && !current.walk.owner.signal.aborted)
          current.walk.requests.add(request);
        else current.waiting.add(request);
        start(current);
        if (signal?.aborted) cancel();
      });
    },
    invalidate(repositoryId: string) {
      for (const [key, snapshot] of snapshots) {
        if (snapshot.repositoryId !== repositoryId) continue;
        snapshots.delete(key);
        retire(snapshot);
      }
    },
    dispose() {
      disposed = true;
      for (const snapshot of snapshots.values()) retire(snapshot);
      snapshots.clear();
    },
  };
}
