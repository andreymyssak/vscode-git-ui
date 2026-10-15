import { createHash } from 'node:crypto';

export type DiagnosticEvent =
  | 'queue.accepted'
  | 'queue.started'
  | 'queue.finished'
  | 'operation.accepted'
  | 'operation.duplicate'
  | 'operation.started'
  | 'operation.write-finished'
  | 'operation.finished'
  | 'command.started'
  | 'command.finished'
  | 'read.started'
  | 'read.finished'
  | 'read.discarded'
  | 'draft.storage-failed'
  | 'draft.storage-recovered';

type Level = 'debug' | 'warn' | 'info';

interface Metadata {
  repositoryId?: string;
  requestId?: string | undefined;
  generation?: number;
  source?:
    | 'history'
    | 'references'
    | 'changes'
    | 'stashes'
    | 'operation'
    | 'worktrees'
    | 'authors'
    | 'blame'
    | 'resolve';
  elapsedMs?: number;
  command?: string | undefined;
  outcome?: 'success' | 'error' | 'cancelled' | 'superseded';
  error?: unknown;
}

let destination: ((level: Level, entry: string) => void) | null = null;
const correlation = (value: string | undefined) =>
  value === undefined
    ? undefined
    : createHash('sha256').update(value).digest('hex').slice(0, 12);
const commands = new Set([
  'rev-parse',
  'status',
  'log',
  'show',
  'diff',
  'for-each-ref',
  'ls-files',
  'ls-tree',
  'blame',
  'stash',
  'fetch',
  'branch',
  'update-ref',
  'rebase',
  'merge',
  'commit',
  'cherry-pick',
  'revert',
  'reset',
  'apply',
  'worktree',
]);

/** No raw paths, user text, command arguments or Error.message cross this boundary. */
export const diagnostics = {
  record(event: DiagnosticEvent, metadata: Metadata = {}): void {
    if (!destination) return;
    const errorKind =
      metadata.error instanceof Error
        ? [
            'AbortError',
            'TimeoutError',
            'Error',
            'TypeError',
            'RangeError',
          ].includes(metadata.error.name)
          ? metadata.error.name
          : 'Error'
        : metadata.error === undefined
          ? undefined
          : 'unknown';
    const entry = {
      event,
      repository: correlation(metadata.repositoryId),
      request: correlation(metadata.requestId),
      generation: metadata.generation,
      source: metadata.source,
      elapsedMs:
        metadata.elapsedMs === undefined
          ? undefined
          : Math.round(metadata.elapsedMs),
      command:
        metadata.command === undefined
          ? undefined
          : commands.has(metadata.command)
            ? metadata.command
            : 'other',
      outcome: metadata.outcome,
      errorKind,
    };

    try {
      destination(
        event === 'draft.storage-failed'
          ? 'warn'
          : event === 'draft.storage-recovered'
            ? 'info'
            : 'debug',
        JSON.stringify(entry),
      );
    } catch {
      /* Logging is observational and cannot affect product operations. */
    }
  },
};

export function installDiagnostics(
  write: (level: Level, entry: string) => void,
) {
  destination = write;

  return {
    dispose() {
      if (destination === write) destination = null;
    },
  };
}
