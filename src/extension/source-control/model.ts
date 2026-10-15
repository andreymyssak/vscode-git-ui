import type { RepositoryInfo } from '../../shared/model';
import type {
  CommitMode,
  Loaded,
  SourceControlOperation,
  SourceControlRepository,
  SourceControlState,
  SourceControlTab,
  Stash,
  StashEntry,
  StashFile,
  StashFileKey,
  WorkingFile,
} from '../../shared/source-control';
import { isRecord } from '../../shared/validation';
import { CheckedFiles } from '../changes/checked-files';

interface DraftStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface RepositorySession {
  info: RepositoryInfo;
  changes: Loaded<WorkingFile>;
  stashes: Loaded<StashEntry>;
  operation: Loaded<SourceControlOperation>;
  checked: CheckedFiles<WorkingFile>;
  commitMode: CommitMode;
}

const DRAFT_KEY = 'gitUI.sourceControlDrafts';
const STASH_VIEW_KEY = 'gitUI.stashViewIdentities';
const gitObjectId = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const stashViewId = /^(?:[a-f\d]{40}|[a-f\d]{64})(?::[1-9]\d*)?$/i;

type ModelState = Omit<SourceControlState, 'hoverDelay' | 'repositories'> & {
  repositories: Omit<SourceControlRepository, 'pathLabel'>[];
};

/** Host-owned inclusion and drafts survive recreation of the webview document. */
export class SourceControlModel {
  readonly repositories = new Map<string, RepositorySession>();
  private readonly drafts = new Map<string, string>();
  private readonly stashViewIds = new Map<string, Map<string, string>>();
  private readonly draftEditIds = new Map<string, string>();
  private readonly beforeAmend = new Map<
    string,
    { draft: string; loaded: string }
  >();

  repositoryId: string | null = null;
  tab: SourceControlTab = 'commit';
  busy = false;
  activity: Exclude<SourceControlState['activity'], undefined> = null;
  generating = false;
  error: string | null = null;
  reveal: SourceControlState['reveal'] = null;

  constructor(private readonly storage: DraftStorage) {
    const saved = storage.get(DRAFT_KEY);

    if (Array.isArray(saved))
      for (const entry of saved)
        if (
          isRecord(entry) &&
          typeof entry.repositoryId === 'string' &&
          typeof entry.message === 'string'
        )
          this.drafts.set(entry.repositoryId, entry.message);

    const views = storage.get(STASH_VIEW_KEY);

    if (Array.isArray(views))
      for (const entry of views)
        if (
          isRecord(entry) &&
          typeof entry.repositoryId === 'string' &&
          entry.repositoryId.length > 0 &&
          entry.repositoryId.length <= 8192 &&
          typeof entry.sha === 'string' &&
          gitObjectId.test(entry.sha) &&
          typeof entry.viewId === 'string' &&
          entry.viewId.length <= 8192 &&
          stashViewId.test(entry.viewId)
        ) {
          const aliases = this.stashAliases(entry.repositoryId);

          if (![...aliases.values()].includes(entry.viewId))
            aliases.set(entry.sha, entry.viewId);
        }
  }

  state(): ModelState {
    return {
      repositories: [...this.repositories.values()].map((repo) => ({
        info: repo.info,
        changes: repo.changes,
        stashes: repo.stashes,
        operation: repo.operation,
        checked: [...new Set(repo.checked.selected().map((file) => file.path))],
        draft: this.draft(repo.info.id),
        draftEditId: this.draftEditIds.get(repo.info.id) ?? null,
        commitMode: repo.commitMode,
      })),
      repositoryId: this.repositoryId,
      tab: this.tab,
      busy: this.busy,
      activity: this.activity,
      generating: this.generating,
      reveal: this.reveal,
    };
  }

  updateRepositories(infos: RepositoryInfo[]): void {
    const ids = new Set(infos.map((info) => info.id));

    for (const id of this.repositories.keys())
      if (!ids.has(id)) this.repositories.delete(id);
    for (const info of infos) {
      const previous = this.repositories.get(info.id);

      if (previous) previous.info = info;
      else
        this.repositories.set(info.id, {
          info,
          operation: { kind: 'ready', items: [] },
          changes: { kind: 'loading' },
          stashes: { kind: 'loading' },
          checked: new CheckedFiles<WorkingFile>(),
          commitMode: { kind: 'new' },
        });
    }

    if (!this.repositoryId || !ids.has(this.repositoryId))
      this.repositoryId = infos.length === 1 ? (infos[0]?.id ?? null) : null;
  }

  requireRepository(id: string): RepositorySession {
    const repo = this.repositories.get(id);

    if (!repo)
      throw new Error(
        'The repository is unavailable. Refresh and select it again.',
      );

    return repo;
  }

  workingFiles(
    id: string,
    paths: readonly string[],
    section?: 'index' | 'working',
  ): WorkingFile[] {
    const repo = this.requireRepository(id);

    if (repo.changes.kind !== 'ready')
      throw new Error('Wait for changes to load before selecting files.');
    const items = repo.changes.items;
    const files = [...new Set(paths)].map((path) =>
      items.filter(
        (file) =>
          file.path === path &&
          (section === 'index'
            ? file.staged
            : section === 'working'
              ? file.working || file.untracked
              : true),
      ),
    );

    if (files.some((entries) => !entries.length))
      throw new Error(
        'Changed files are unavailable. Refresh and check them again.',
      );

    return files.flat();
  }

  selectedFiles(id: string): WorkingFile[] {
    const files = this.requireRepository(id).checked.selected();

    if (!files.length) throw new Error('Check at least one changed file.');
    this.workingFiles(
      id,
      files.map((file) => file.path),
    );

    return files;
  }

  requireStash(id: string, sha: string): StashEntry {
    const repo = this.requireRepository(id);
    const stash =
      repo.stashes.kind === 'ready'
        ? repo.stashes.items.find((item) => item.sha === sha)
        : undefined;

    if (!stash)
      throw new Error('The stash is unavailable. Refresh and select it again.');

    return stash;
  }

  stashFiles(
    id: string,
    sha: string,
    keys: readonly StashFileKey[],
  ): StashFile[] {
    const stash = this.requireStash(id, sha);

    if (stash.files?.kind !== 'ready')
      throw new Error('Wait for saved files to load before selecting them.');
    const files = keys.map((key) =>
      stash.files?.kind === 'ready'
        ? stash.files.items.find(
            (file) => file.path === key.path && file.snapshot === key.snapshot,
          )
        : undefined,
    );

    if (!files.length || files.some((file) => file === undefined))
      throw new Error(
        'Saved files are unavailable. Refresh and select them again.',
      );

    return files.filter((file) => file !== undefined);
  }

  updateChanges(id: string, changes: Loaded<WorkingFile>): void {
    const repo = this.requireRepository(id);

    repo.changes = changes;
    if (changes.kind === 'ready') repo.checked.refresh(changes.items);
  }

  updateStashes(id: string, stashes: Loaded<Stash>): void {
    const repo = this.requireRepository(id);
    const previous =
      repo.stashes.kind === 'ready'
        ? new Map(repo.stashes.items.map((stash) => [stash.sha, stash]))
        : new Map<string, StashEntry>();
    const aliases = this.stashAliases(id);
    const reserved = new Set(aliases.values());
    let allocated = false;

    repo.stashes =
      stashes.kind === 'ready'
        ? {
            kind: 'ready',
            items: stashes.items.map((stash) => {
              let viewId = aliases.get(stash.sha);

              if (viewId === undefined) {
                viewId = stash.sha;
                // A recovered old Git object is a separate card from its rewrite.
                for (let suffix = 1; reserved.has(viewId); suffix++)
                  viewId = `${stash.sha}:${suffix}`;
                reserved.add(viewId);
                if (viewId !== stash.sha) {
                  aliases.set(stash.sha, viewId);
                  allocated = true;
                }
              }

              return {
                ...stash,
                viewId,
                files: previous.get(stash.sha)?.files ?? null,
              };
            }),
          }
        : stashes;
    if (allocated)
      void Promise.resolve(this.persistStashViews()).catch(() => undefined);
  }

  async rememberStashRewrite(
    id: string,
    stash: StashEntry,
    nextSha: string,
  ): Promise<void> {
    this.requireRepository(id);
    const aliases = this.stashAliases(id);

    for (const [sha, viewId] of aliases)
      if (viewId === stash.viewId) aliases.delete(sha);
    aliases.set(nextSha, stash.viewId);
    await this.persistStashViews();
  }

  private persistStashViews(): PromiseLike<void> {
    return this.storage.update(
      STASH_VIEW_KEY,
      [...this.stashViewIds].flatMap(([repositoryId, entries]) =>
        [...entries].map(([sha, viewId]) => ({ repositoryId, sha, viewId })),
      ),
    );
  }

  private stashAliases(id: string): Map<string, string> {
    let aliases = this.stashViewIds.get(id);

    if (aliases === undefined) {
      aliases = new Map();
      this.stashViewIds.set(id, aliases);
    }

    return aliases;
  }

  draft(id: string): string {
    return this.drafts.get(id) ?? '';
  }

  setAmend(
    id: string,
    commit: { headSha: string; message: string } | null,
  ): void {
    const repo = this.requireRepository(id);

    if (commit) {
      if (repo.commitMode.kind === 'new') {
        const draft = this.draft(id);

        this.beforeAmend.set(id, { draft, loaded: commit.message });
      }

      repo.commitMode = { kind: 'amend', headSha: commit.headSha };
      this.setDraft(id, commit.message);
    } else {
      const previous = this.beforeAmend.get(id);

      if (
        repo.commitMode.kind === 'amend' &&
        previous &&
        this.draft(id) === previous.loaded
      )
        this.setDraft(id, previous.draft);
      repo.commitMode = { kind: 'new' };
      this.beforeAmend.delete(id);
    }
  }

  committed(id: string): void {
    this.requireRepository(id).commitMode = { kind: 'new' };
    this.beforeAmend.delete(id);
    this.setDraft(id, '');
  }

  setDraft(id: string, message: string, editId: string | null = null): void {
    if (message) this.drafts.set(id, message);
    else this.drafts.delete(id);
    if (editId === null) this.draftEditIds.delete(id);
    else this.draftEditIds.set(id, editId);
    void Promise.resolve(
      this.storage.update(
        DRAFT_KEY,
        [...this.drafts].map(([repositoryId, value]) => ({
          repositoryId,
          message: value,
        })),
      ),
    ).catch(() => undefined);
  }

  selectionIdentity(id: string): string {
    const repo = this.repositories.get(id);

    return JSON.stringify([
      this.repositoryId,
      this.tab,
      this.draft(id),
      repo?.info.headSha,
      repo?.commitMode,
      repo?.changes.kind,
      repo?.checked.selected(),
    ]);
  }
}
