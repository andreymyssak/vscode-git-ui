import type { PanelBody } from '../../shared/messages';
import type { HistoryInput, ScrollAnchor, Selection } from '../../shared/model';
import type { GitAdapter } from '../git/adapter';
import type { PanelDetails } from './details';
import type { PanelHistory } from './history';
import type { QuerySession } from './queries';
import { reconcileSelection } from './selection';

/** Restore the selected commit, file and scroll anchor within one query generation. */
export async function restoreHistorySelection({
  session,
  query,
  history,
  adapter,
  details,
  desired,
  anchor,
  requestId,
  send,
  onScopeChange,
}: {
  session: QuerySession;
  query: HistoryInput;
  history: PanelHistory;
  adapter: GitAdapter;
  details: PanelDetails;
  desired: Selection | null;
  anchor: ScrollAnchor | null;
  requestId: string;
  send(
    this: void,
    body: PanelBody,
    requestId: string,
    id?: string,
    generation?: number,
  ): Promise<void>;
  onScopeChange(this: void, query: HistoryInput): void;
}): Promise<void> {
  const id = session.repositoryId;
  const generation = session.generation;
  const current = () => session.current(id, generation);
  const selectionEpoch = session.detailEpoch;

  try {
    await history.start(query, requestId, true);
    if (!current()) return;
    if (query.scope.kind === 'ref') {
      const refId = query.scope.refId;
      const refs = await adapter.references(id);

      if (!current()) return;
      if (!refs.some((ref) => ref.id === refId)) {
        query = { ...query, scope: { kind: 'head' } };
        onScopeChange(query);
        await send(
          {
            kind: 'notice',
            message: 'The selected reference disappeared. Showing HEAD.',
          },
          requestId,
        );
      }
    }

    await history.loadUntil(
      query,
      requestId,
      [desired?.sha, anchor?.sha].filter(
        (sha): sha is string => sha !== undefined,
      ),
      () => current() && session.detailEpoch === selectionEpoch,
    );
    if (!current() || session.detailEpoch !== selectionEpoch) return;
    const retainedAnchor =
      anchor && session.commits.has(anchor.sha) ? anchor : null;
    const commit = desired ? session.commits.get(desired.sha) : null;

    if (!desired || !commit) {
      session.selection = null;
      session.selectedSha = null;
      session.anchor = retainedAnchor;
      await send(
        {
          kind: 'selection',
          sha: null,
          parentSha: null,
          filePath: null,
          anchor: retainedAnchor,
        },
        requestId,
      );

      return;
    }

    const valid = reconcileSelection(desired, {
      inQuery: true,
      parents: commit.parents,
      files: desired.filePath ? [desired.filePath] : [],
    })!;
    const epoch = session.select(valid.sha);

    session.selection = valid;
    session.anchor = retainedAnchor;
    await send(
      { kind: 'selection', ...valid, anchor: retainedAnchor },
      requestId,
    );
    await send({ kind: 'details', commit }, requestId);
    await details.files(valid.sha, valid.parentSha, epoch, requestId);
    if (
      !current() ||
      session.selectedSha !== valid.sha ||
      session.detailEpoch !== epoch
    )
      return;
    const paths = [...session.files.values()]
      .filter((handle) => handle.parentSha === valid.parentSha)
      .flatMap((handle) =>
        [handle.file.newPath, handle.file.oldPath].filter(
          (path): path is string => path !== null,
        ),
      );
    const selection = reconcileSelection(valid, {
      inQuery: true,
      parents: commit.parents,
      files: paths,
    })!;

    session.selection = selection;
    await send(
      { kind: 'selection', ...selection, anchor: retainedAnchor },
      requestId,
    );
  } finally {
    if (current())
      await send({ kind: 'history-settled' }, requestId, id, generation);
  }
}
