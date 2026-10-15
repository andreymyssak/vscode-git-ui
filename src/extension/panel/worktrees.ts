import { extensionIdentity } from '../../shared/extension-identity';
import type { PanelBody, Request, RequestBody } from '../../shared/messages';
import type { GitAction, Reference, WorktreeInfo } from '../../shared/model';
import { canOpenWorktree } from '../../shared/worktree-selection';
import type { GitAdapter } from '../git/adapter';
import type { PanelNotifications } from './notifications';
import { type QuerySession, waitForQuery } from './queries';

interface WorktreePublication {
  adapter: GitAdapter | null;
  session: QuerySession;
  notifications: PanelNotifications;
  send(this: void, body: PanelBody, requestId: string): Promise<void>;
}

/** Keeps list reads and issued worktree handles in the same generation. */
export class PanelWorktrees {
  private revision = 0;
  private read = new AbortController();

  constructor(private readonly publication: WorktreePublication) {}

  load(requestId = 'host'): Promise<void> {
    this.read.abort();
    this.read = new AbortController();

    return waitForQuery(
      this.loadCurrent(requestId, ++this.revision),
      AbortSignal.any([
        this.read.signal,
        this.publication.session.abort.signal,
      ]),
    );
  }

  private async loadCurrent(
    requestId: string,
    revision: number,
  ): Promise<void> {
    const { adapter, session } = this.publication;

    if (!adapter) return;
    const id = session.repositoryId;
    const generation = session.generation;
    const current = () =>
      revision === this.revision && session.current(id, generation);
    let worktrees;

    try {
      await this.publication.send(
        { kind: 'worktrees-loading', loading: true },
        requestId,
      );
      if (!current()) return;
      worktrees = await adapter.worktrees(
        id,
        AbortSignal.any([this.read.signal, session.abort.signal]),
      );
      if (!current()) return;
      session.worktrees.clear();
      for (const worktree of worktrees)
        session.worktrees.set(worktree.id, worktree);
      await this.publication.send({ kind: 'worktrees', worktrees }, requestId);
    } catch (error) {
      if (current())
        await this.publication.notifications.readFailed(
          'worktrees',
          error,
          'Could not load worktrees.',
          requestId,
          id,
          generation,
        );
    } finally {
      if (current())
        await this.publication.send(
          { kind: 'worktrees-loading', loading: false },
          requestId,
        );
    }
  }
}

export interface WorktreeOpening {
  openWorktree?: (
    worktree: WorktreeInfo,
    destination: 'new' | 'current',
  ) => Promise<void>;
}

/** Opens a fresh, issued worktree only while its browser session is current. */
export async function openSelectedWorktree(
  adapter: GitAdapter,
  session: QuerySession,
  request: Request<RequestBody>,
  body: Extract<RequestBody, { kind: 'open-worktree' }>,
  options: WorktreeOpening,
): Promise<void> {
  const known = session.worktrees.get(body.worktreeId);

  if (!known) throw new Error('Select a worktree from the current list.');
  const current = () =>
    session.current(request.repositoryId, request.generation);
  const read = async () => {
    const fresh = (await adapter.worktrees(request.repositoryId)).find(
      (item) => item.id === known.id,
    );

    if (!current()) return null;
    if (fresh?.current) throw new Error('This worktree is already open.');
    if (!fresh || fresh.rootUri !== known.rootUri || !canOpenWorktree(fresh))
      throw new Error(
        'The worktree folder is unavailable. Refresh the worktree list.',
      );

    return fresh;
  };

  const fresh = await read();

  if (fresh && current())
    await options.openWorktree?.(fresh, body.newWindow ? 'new' : 'current');
}

export interface WorktreeCreationPrompts {
  pickWorktreeBranch?: (
    references: readonly Reference[],
    currentBranch: string | null,
  ) => Promise<string | null>;
  askWorktree?: (
    reference: Reference,
    rootUri: string,
    currentBranch: string | null,
  ) => Promise<{ path: string; name: string | null } | null>;
}

/** Toolbar creation chooses an adapter-owned branch; row actions keep their displayed target. */
export async function prepareNewWorktree(
  adapter: GitAdapter,
  session: QuerySession,
  request: Pick<Request<unknown>, 'repositoryId' | 'generation'>,
  refId: string | undefined,
  prompts: WorktreeCreationPrompts,
): Promise<GitAction | null> {
  const check = () => {
    if (!session.current(request.repositoryId, request.generation))
      throw new Error(
        `The ${extensionIdentity.displayName} view changed. Choose Create Worktree again.`,
      );
  };

  check();
  const repo = adapter
    .repositories()
    .find((item) => item.id === request.repositoryId);

  if (!repo) throw new Error('Select an available repository.');
  let ref = refId === undefined ? undefined : session.refs.get(refId);

  if (refId === undefined) {
    const branches = (await adapter.references(repo.id)).filter(
      (item) => item.kind !== 'tag',
    );

    check();
    if (!branches.length)
      throw new Error('No branches are available for a worktree.');
    const selected = await prompts.pickWorktreeBranch?.(branches, repo.branch);

    check();
    if (selected === null || selected === undefined) return null;
    ref = branches.find((item) => item.id === selected);
  }

  if (!ref || ref.kind === 'tag')
    throw new Error('Select a local or remote branch.');
  const choice = await prompts.askWorktree?.(ref, repo.rootUri, repo.branch);

  check();

  return choice
    ? {
        kind: 'create-worktree',
        refId: ref.id,
        expectedSha: ref.sha,
        ...choice,
      }
    : null;
}
