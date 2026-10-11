import type { Loaded } from '../../shared/source-control';

/** Explicit actions notify each time; background reads notify once until recovery. */
export class SourceControlNotifications {
  private readonly failures = new Map<string, Map<string, string>>();
  private connectionFailure: string | null = null;

  constructor(private readonly report: (message: string) => void) {}

  load(
    repositoryId: string,
    resource: string,
    label: string,
    state: Loaded<unknown>,
  ): void {
    if (state.kind === 'loading') return;
    const failures =
      this.failures.get(repositoryId) ?? new Map<string, string>();

    if (state.kind === 'ready') {
      failures.delete(resource);
      if (!failures.size) this.failures.delete(repositoryId);

      return;
    }

    const message = `${label}: ${state.message}`;

    if (failures.get(resource) === message) return;
    failures.set(resource, message);
    this.failures.set(repositoryId, failures);
    this.report(message);
  }

  connection(message: string | null): void {
    if (message === this.connectionFailure) return;
    this.connectionFailure = message;
    if (message) this.report(message);
  }

  retainRepositories(ids: ReadonlySet<string>): void {
    for (const id of this.failures.keys())
      if (!ids.has(id)) this.failures.delete(id);
  }

  reset(): void {
    this.failures.clear();
    this.connectionFailure = null;
  }
}
