import type { PanelBody, Request, RequestBody } from '../../shared/messages';
import type { QuerySession } from './queries';

type ErrorReporter = ((message: string) => Promise<void>) | undefined;

interface RequestFailure {
  error: unknown;
  request: Request<RequestBody>;
  ownedGeneration: number;
}

interface NotificationOptions {
  report: ErrorReporter;
  session: QuerySession;
  closed(this: void): boolean;
  send(
    this: void,
    body: PanelBody,
    requestId: string,
    id: string,
    generation: number,
  ): Promise<void>;
}

/** Repeated reads stay quiet until that same data can be read successfully. */
export class PanelNotifications {
  private readonly failures = new Map<string, Map<string, string>>();

  constructor(private readonly options: NotificationOptions) {}

  async failed(
    repositoryId: string,
    source: string,
    message: string,
  ): Promise<void> {
    const failures =
      this.failures.get(repositoryId) ?? new Map<string, string>();

    if (failures.get(source) === message) return;
    failures.set(source, message);
    this.failures.set(repositoryId, failures);
    await this.options.report?.(message);
  }

  succeeded(repositoryId: string, body: PanelBody): void {
    const source =
      body.kind === 'history' || body.kind === 'worktrees'
        ? body.kind
        : body.kind === 'files'
          ? comparisonSource(body.sha, body.parentSha)
          : null;

    if (source) this.failures.get(repositoryId)?.delete(source);
  }

  retry(source?: string): void {
    const id = this.options.session.repositoryId;

    if (source) this.failures.get(id)?.delete(source);
    else this.failures.delete(id);
  }

  async readFailed(
    source: string,
    error: unknown,
    fallback: string,
    requestId = 'host',
    id = this.options.session.repositoryId,
    generation = this.options.session.generation,
  ): Promise<void> {
    if (this.options.closed()) return;
    const message =
      error instanceof Error && error.message ? error.message : fallback;

    await this.failed(id, source, message);
    await this.options.send(
      { kind: 'error', message },
      requestId,
      id,
      generation,
    );
  }

  async requestFailed({
    error,
    request,
    ownedGeneration,
  }: RequestFailure): Promise<void> {
    if (this.options.closed()) return;
    const { repositoryId, generation } = this.options.session;
    const { report, send } = this.options;
    const message =
      error instanceof Error ? error.message : 'Git request failed.';

    if (
      request.body.kind === 'action' &&
      (request.repositoryId !== repositoryId || ownedGeneration !== generation)
    ) {
      if (report) await report(message);
      else
        await send(
          { kind: 'error', message },
          request.requestId,
          repositoryId,
          generation,
        );

      return;
    }

    if (request.repositoryId === repositoryId && ownedGeneration !== generation)
      return;
    const initial =
      request.body.kind === 'ready' ||
      request.body.kind === 'choose-repository';
    const id = initial ? repositoryId : request.repositoryId;
    const read =
      initial ||
      request.body.kind === 'history' ||
      request.body.kind === 'restore';

    if (read) await this.failed(id, 'history', message);
    else await report?.(message);
    await send(
      { kind: 'error', message },
      request.requestId,
      id,
      initial ? generation : ownedGeneration,
    );
  }
}

export function comparisonSource(
  sha: string,
  parentSha: string | null,
): string {
  return JSON.stringify(['files', sha, parentSha]);
}
