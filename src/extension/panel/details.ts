import type { PanelBody } from '../../shared/messages';
import type { GitAdapter } from '../git/adapter';
import type { FileHandle, QuerySession } from './queries';

interface DetailsPublication {
  send(body: PanelBody, requestId: string): Promise<void>;
  reportError(
    id: string,
    sha: string,
    parentSha: string | null,
    message: string,
  ): Promise<void>;
  openChange(
    id: string,
    handle: FileHandle,
    preview: boolean,
    current: () => boolean,
  ): Promise<void>;
}

/** Owns active commit reads and the file handles published for that comparison. */
export class PanelDetails {
  private loadedEpoch: number | null = null;
  private pendingEpoch: number | null = null;
  private activation = 0;
  private readonly comparisons = new Map<string, Promise<void>>();

  constructor(
    private readonly adapter: GitAdapter,
    private readonly session: QuerySession,
    private readonly publication: DetailsPublication,
  ) {}

  async select(
    shas: readonly string[],
    activeSha: string,
    requestId: string,
  ): Promise<void> {
    const commit = this.session.commits.get(activeSha);

    if (
      !commit ||
      !shas.includes(activeSha) ||
      !shas.every((sha) => this.session.commits.has(sha))
    )
      throw new Error('Select a loaded commit range from the current history.');
    const epoch = this.session.selectRange(shas, activeSha);

    if (this.loadedEpoch === epoch || this.pendingEpoch === epoch) return;
    this.session.selection = {
      sha: activeSha,
      parentSha: commit.parents[0] ?? null,
      filePath: null,
    };
    this.pendingEpoch = epoch;
    try {
      await this.publication.send({ kind: 'details', commit }, requestId);
      await this.files(activeSha, commit.parents[0] ?? null, epoch, requestId);
    } finally {
      if (this.pendingEpoch === epoch) this.pendingEpoch = null;
    }
  }

  async parent(
    sha: string,
    parentSha: string | null,
    requestId: string,
  ): Promise<void> {
    const commit = this.session.commits.get(sha);

    if (
      this.session.selectedSha !== sha ||
      !commit ||
      (parentSha === null
        ? commit.parents.length !== 0
        : !commit.parents.includes(parentSha))
    )
      throw new Error('This parent comparison is obsolete.');
    await this.files(sha, parentSha, this.session.detailEpoch, requestId);
  }

  async open(fileId: string, preview: boolean): Promise<void> {
    const handle = this.session.files.get(fileId);

    if (!handle || handle.sha !== this.session.selectedSha)
      throw new Error('Select a file from the current commit.');
    const activation = ++this.activation;
    const id = this.session.repositoryId;
    const generation = this.session.generation;
    const epoch = this.session.detailEpoch;

    this.session.selection = {
      sha: handle.sha,
      parentSha: handle.parentSha,
      filePath: handle.file.newPath ?? handle.file.oldPath,
    };
    await this.publication.openChange(
      id,
      handle,
      preview,
      () =>
        activation === this.activation &&
        this.session.current(id, generation) &&
        this.session.detailEpoch === epoch &&
        this.session.files.get(fileId) === handle,
    );
  }

  async files(
    sha: string,
    parentSha: string | null,
    epoch: number,
    requestId: string,
  ): Promise<void> {
    const id = this.session.repositoryId;
    const generation = this.session.generation;
    const key = JSON.stringify([id, generation, epoch, sha, parentSha]);
    const pending = this.comparisons.get(key);

    if (pending) return pending;
    const loading = this.loadFiles(
      id,
      generation,
      sha,
      parentSha,
      epoch,
      requestId,
    );

    this.comparisons.set(key, loading);
    try {
      await loading;
    } finally {
      this.comparisons.delete(key);
    }
  }

  private async loadFiles(
    id: string,
    generation: number,
    sha: string,
    parentSha: string | null,
    epoch: number,
    requestId: string,
  ): Promise<void> {
    const current = () =>
      this.session.current(id, generation) &&
      this.session.selectedSha === sha &&
      this.session.detailEpoch === epoch;
    let files;

    try {
      files = await this.adapter.changes(id, sha, parentSha);
    } catch (error) {
      if (!current()) return;
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Could not load this comparison.';

      await this.publication.reportError(id, sha, parentSha, message);
      await this.publication.send(
        {
          kind: 'files-error',
          sha,
          parentSha,
          message,
        },
        requestId,
      );

      return;
    }

    if (!current()) return;
    for (const file of files)
      this.session.files.set(file.id, { sha, parentSha, file });
    this.loadedEpoch = epoch;
    await this.publication.send(
      { kind: 'files', sha, parentSha, files },
      requestId,
    );
  }
}
