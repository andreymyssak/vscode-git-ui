import type { PanelBody } from '../../shared/messages';
import type { PanelOperations } from './operation-progress';
import type { QuerySession } from './queries';

/** A later write revokes only the same repository's obsolete UI reads. */
export class PanelWriteOwnership {
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly session: QuerySession,
    private readonly operations: Pick<PanelOperations, 'isRefreshing'>,
    private readonly closed: () => boolean,
    private readonly send: (
      body: PanelBody,
      id: string,
      generation: number,
    ) => Promise<void>,
  ) {}

  async begin(id: string): Promise<() => boolean> {
    const revision = (this.revisions.get(id) ?? 0) + 1;

    this.revisions.set(id, revision);
    if (this.session.repositoryId === id && this.operations.isRefreshing(id)) {
      const generation = this.session.generation;

      this.session.abort.abort();
      await this.send({ kind: 'history-interrupted' }, id, generation);
      await this.send(
        { kind: 'worktrees-loading', loading: false },
        id,
        generation,
      );
    }

    return () => revision === this.revisions.get(id) && !this.closed();
  }
}
