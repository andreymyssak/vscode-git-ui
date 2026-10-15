import type { SourceControlModel } from './model';

/** Only the affected repository's file and conflict reads own Changes activity. */
export class SourceControlReadProgress {
  private pending: {
    activity: { repositoryId: string; title: string };
    remaining: Set<string>;
  } | null = null;

  constructor(
    private readonly model: SourceControlModel,
    private readonly publish: () => void,
  ) {}

  start(repositoryId: string) {
    const activity = { repositoryId, title: 'Refreshing changes…' };

    this.pending = { activity, remaining: new Set(['changes', 'operation']) };
    this.model.activity = activity;

    return () => this.pending?.activity === activity;
  }

  cancel(): void {
    this.pending = null;
  }

  begin(): void {
    if (this.pending)
      this.pending.remaining = new Set(['changes', 'operation']);
  }

  settled(repositoryId: string, source: string): void {
    const pending = this.pending;

    if (pending?.activity.repositoryId !== repositoryId) return;
    pending.remaining.delete(source);
    if (!pending.remaining.size) this.finish();
  }

  retain(ids: ReadonlySet<string>): void {
    if (this.pending && !ids.has(this.pending.activity.repositoryId))
      this.finish();
  }

  finish(): void {
    if (this.pending && this.model.activity === this.pending.activity) {
      this.model.activity = null;
      this.publish();
    }

    this.pending = null;
  }
}
