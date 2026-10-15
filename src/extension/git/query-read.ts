import { diagnostics } from '../diagnostics';
import { backgroundRead } from './background-read';

type Source =
  | 'history'
  | 'references'
  | 'changes'
  | 'worktrees'
  | 'authors'
  | 'blame'
  | 'resolve';

let sequence = 0;

/** Own cancellation for public-API reads as well as their private CLI subprocesses. */
export async function queryRead<T>(
  source: Source,
  repositoryId: string,
  signal: AbortSignal | undefined,
  read: (owner: AbortSignal) => Promise<T>,
): Promise<T> {
  const generation = ++sequence;
  const started = performance.now();

  diagnostics.record('read.started', { source, repositoryId, generation });
  try {
    const value = await backgroundRead(read, signal);

    diagnostics.record('read.finished', {
      source,
      repositoryId,
      generation,
      outcome: 'success',
      elapsedMs: performance.now() - started,
    });

    return value;
  } catch (error) {
    diagnostics.record('read.finished', {
      source,
      repositoryId,
      generation,
      error,
      outcome: signal?.aborted ? 'cancelled' : 'error',
      elapsedMs: performance.now() - started,
    });
    throw error;
  }
}
