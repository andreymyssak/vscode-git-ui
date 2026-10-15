import type {
  CommitRecord,
  FileChange,
  Reference,
  RepositoryInfo,
  ScrollAnchor,
  Selection,
  WorktreeInfo,
} from '../../shared/model';
import type { GitAdapter } from '../git/adapter';

export interface FileHandle {
  sha: string;
  parentSha: string | null;
  file: FileChange;
}
export class QuerySession {
  repositoryId = '';
  generation = 0;
  selectedSha: string | null = null;
  selectedShas: readonly string[] = [];
  rangeRevision = 0;
  rangeAbort = new AbortController();
  selection: Selection | null = null;
  anchor: ScrollAnchor | null = null;
  repositoryInfo: RepositoryInfo | null = null;
  readonly refs = new Map<string, Reference>();
  detailEpoch = 0;
  detailAbort = new AbortController();
  abort = new AbortController();
  readonly commits = new Map<string, CommitRecord>();
  historyShas: string[] = [];
  readonly files = new Map<string, FileHandle>();
  readonly worktrees = new Map<string, WorktreeInfo>();
  begin(repositoryId: string, generation = this.generation + 1): void {
    this.detailAbort.abort();
    this.detailAbort = new AbortController();
    this.rangeAbort.abort();
    this.rangeAbort = new AbortController();
    this.rangeRevision++;
    this.selectedShas = [];
    this.abort.abort();
    this.abort = new AbortController();
    this.repositoryId = repositoryId;
    this.generation = generation;
    this.selectedSha = null;
    this.selection = null;
    this.anchor = null;
    this.detailEpoch++;
    this.commits.clear();
    this.historyShas = [];
    this.refs.clear();
    this.repositoryInfo = null;
    this.files.clear();
    this.worktrees.clear();
  }

  select(sha: string): number {
    this.setRange([sha]);

    return this.selectActive(sha);
  }

  private setRange(shas: readonly string[]): void {
    if (
      shas.length === this.selectedShas.length &&
      shas.every((sha, index) => sha === this.selectedShas[index])
    )
      return;
    this.rangeAbort.abort();
    this.rangeAbort = new AbortController();
    this.rangeRevision++;
    this.selectedShas = [...shas];
  }

  selectRange(shas: readonly string[], activeSha: string): number {
    this.setRange(shas);

    return this.selectedSha === activeSha
      ? this.detailEpoch
      : this.selectActive(activeSha);
  }

  private selectActive(sha: string): number {
    this.detailAbort.abort();
    this.detailAbort = new AbortController();
    this.selectedSha = sha;
    this.selection = { sha, parentSha: null, filePath: null };
    this.files.clear();

    return ++this.detailEpoch;
  }

  current(id: string, generation: number): boolean {
    return (
      this.repositoryId === id &&
      this.generation === generation &&
      !this.abort.signal.aborted
    );
  }

  dispose(): void {
    this.detailAbort.abort();
    this.rangeAbort.abort();
    this.abort.abort();
    this.files.clear();
    this.commits.clear();
    this.refs.clear();
    this.repositoryInfo = null;
    this.worktrees.clear();
  }
}

export function getRepository(
  adapter: GitAdapter | null,
  id: string,
): RepositoryInfo {
  const repository = adapter
    ?.repositories()
    .find((candidate) => candidate.id === id);

  if (!repository)
    throw new Error('Repository is no longer available. Refresh the view.');

  return repository;
}

/** Obsolete UI reads release lifecycle ownership even if the provider cannot cancel. */
export function waitForQuery(
  read: Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finished = () => {
      signal.removeEventListener('abort', finished);
      resolve();
    };

    signal.addEventListener('abort', finished, { once: true });
    void read.then(finished, (error: unknown) => {
      signal.removeEventListener('abort', finished);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    if (signal.aborted) finished();
  });
}
