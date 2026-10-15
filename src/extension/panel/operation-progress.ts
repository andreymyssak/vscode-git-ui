import type { ActiveLogOperation, PanelBody } from '../../shared/messages';

type Progress = Omit<ActiveLogOperation, 'requestId'>;

type Publication = {
  repositoryId: string;
  requestId: string;
  body: Extract<PanelBody, { kind: 'operation-progress' }>;
};

interface Operation {
  repositoryId: string;
  requestId: string;
  description: Pick<Progress, 'label' | 'refIds' | 'section'> | null;
  key?: string;
  independent?: boolean;
  work(this: void, progress: OperationProgress): Promise<void>;
}

export interface OperationProgress {
  refreshing(this: void): Promise<void>;
  git(this: void, phase: 'waiting' | 'running'): Promise<void>;
}

interface PendingOperation {
  operation: Operation;
  phase: 'queued' | Progress['phase'];
}

/** Git writes stay ordered; captured targets can proceed during earlier UI reads. */
export class PanelOperations {
  private readonly active = new Map<
    string,
    { progress: ActiveLogOperation; key: string }
  >();

  private readonly completion = new Map<string, Promise<void>>();
  private readonly settlements = new Map<string, Set<Promise<void>>>();
  private readonly pending = new Map<string, Map<string, PendingOperation>>();
  private readonly publications = new Map<string, Promise<void>>();

  constructor(
    private readonly deliver: (message: Publication) => Promise<void>,
  ) {}

  private async send(message: Publication): Promise<void> {
    const previous =
      this.publications.get(message.repositoryId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.deliver(message));

    this.publications.set(message.repositoryId, next);
    try {
      await next;
    } finally {
      if (this.publications.get(message.repositoryId) === next)
        this.publications.delete(message.repositoryId);
    }
  }

  has(repositoryId: string, key: string): boolean {
    return this.pending.get(repositoryId)?.has(key) ?? false;
  }

  isRefreshing(repositoryId: string): boolean {
    return [...(this.pending.get(repositoryId)?.values() ?? [])].some(
      (item) => item.phase === 'refreshing',
    );
  }

  async run(operation: Operation): Promise<void> {
    const { repositoryId, description, work } = operation;

    if (!description)
      return work({ refreshing: async () => {}, git: async () => {} });
    const key = operation.key ?? operation.requestId;
    const pending =
      this.pending.get(repositoryId) ?? new Map<string, PendingOperation>();

    if (pending.has(key)) return;
    pending.set(key, { operation, phase: 'queued' });
    this.pending.set(repositoryId, pending);
    const previous = this.completion.get(repositoryId);
    const settlements =
      this.settlements.get(repositoryId) ?? new Set<Promise<void>>();
    const predecessors = operation.independent ? [] : [...settlements];
    let release: () => void = () => {};

    const writing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = Promise.allSettled([
      ...(previous ? [previous] : []),
      ...predecessors,
    ]);
    const completion = ready.then(() => this.perform(operation, key, release));
    const writeCompletion = ready.then(() => writing);

    settlements.add(completion);
    this.settlements.set(repositoryId, settlements);
    this.completion.set(repositoryId, writeCompletion);
    try {
      try {
        if (previous) await this.publish(repositoryId);
      } finally {
        // A failed webview publication cannot release an accepted write's place.
        await completion;
      }
    } finally {
      settlements.delete(completion);
      if (!settlements.size) this.settlements.delete(repositoryId);
      if (this.completion.get(repositoryId) === writeCompletion)
        this.completion.delete(repositoryId);
    }
  }

  /** Native Restore can be chosen while the deletion is still refreshing. */
  afterCurrent(operation: Operation): Promise<void> {
    return this.run(operation);
  }

  private async perform(
    { repositoryId, requestId, description, work }: Operation,
    key: string,
    release: () => void,
  ): Promise<void> {
    if (!description) return;
    const pending = this.pending.get(repositoryId);
    const entry = pending?.get(key);

    if (entry) entry.phase = 'running';
    this.active.set(repositoryId, {
      key,
      progress: { ...description, requestId, phase: 'running' },
    });
    try {
      await this.publish(repositoryId);
      await work({
        refreshing: () => this.refreshing(repositoryId, key, release),
        git: async (phase) => {
          const active = this.active.get(repositoryId);

          if (active?.key !== key) return;
          if (entry) entry.phase = phase;
          active.progress = { ...active.progress, phase };
          await this.publish(repositoryId);
        },
      });
    } finally {
      pending?.delete(key);
      try {
        if (this.active.get(repositoryId)?.key === key) {
          this.active.delete(repositoryId);
          await this.send({
            repositoryId,
            requestId,
            body: { kind: 'operation-progress', operation: null },
          });
        }
      } finally {
        if (!pending?.size) this.pending.delete(repositoryId);
        release();
      }
    }
  }

  private async refreshing(
    repositoryId: string,
    key: string,
    release: () => void,
  ): Promise<void> {
    const operation = this.active.get(repositoryId);

    if (!operation || operation.key !== key) return;
    const entry = this.pending.get(repositoryId)?.get(key);

    if (entry) entry.phase = 'refreshing';
    this.active.set(repositoryId, {
      ...operation,
      progress: { ...operation.progress, phase: 'refreshing' },
    });
    try {
      await this.publish(repositoryId);
    } finally {
      release();
    }
  }

  async publish(repositoryId: string): Promise<void> {
    const operation = this.active.get(repositoryId);

    if (!operation) return;
    const { requestId, ...progress } = operation.progress;
    const queued = [...(this.pending.get(repositoryId)?.entries() ?? [])]
      .filter(([key, item]) => key !== operation.key && item.phase === 'queued')
      .flatMap(([, item]) =>
        item.operation.description ? [item.operation.description] : [],
      );

    await this.send({
      repositoryId,
      requestId,
      body: {
        kind: 'operation-progress',
        operation: { ...progress, ...(queued.length ? { queued } : {}) },
      },
    });
  }
}
