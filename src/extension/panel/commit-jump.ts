export interface CommitJump {
  repositoryId: string;
  sha: string;
}

interface PendingJump {
  target: CommitJump;
  resolve(): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
}

const cancellation = () =>
  new DOMException('Commit navigation was cancelled.', 'AbortError');

export class CommitJumpQueue {
  private pending: PendingJump | null = null;
  private reveal: ((target: CommitJump) => Promise<void>) | null = null;
  private closed = false;

  enqueue(target: CommitJump): Promise<void> {
    if (this.closed) return Promise.reject(cancellation());
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const pending: PendingJump = {
        target,
        resolve,
        reject,
        started: false,
        timer: setTimeout(() => {
          if (this.pending !== pending) return;
          this.pending = null;
          reject(
            new Error(
              `${extensionIdentity.displayName} did not become ready for commit navigation.`,
            ),
          );
        }, 15_000),
      };

      this.pending = pending;
      this.flush();
    });
  }

  attach(reveal: (target: CommitJump) => Promise<void>): void {
    if (this.closed) return;
    this.reveal = reveal;
    this.flush();
  }

  detach(error: unknown = cancellation()): void {
    this.reveal = null;
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }

  private flush(): void {
    queueMicrotask(() => {
      const pending = this.pending;
      const reveal = this.reveal;

      if (!pending || !reveal || pending.started || this.closed) return;
      pending.started = true;
      clearTimeout(pending.timer);
      void Promise.resolve()
        .then(() => reveal(pending.target))
        .then(
          () => {
            if (this.finish(pending)) pending.resolve();
          },
          (error: unknown) => {
            if (this.finish(pending)) pending.reject(error);
          },
        );
    });
  }

  private finish(pending: PendingJump): boolean {
    if (this.pending !== pending) return false;
    this.pending = null;

    return true;
  }

  dispose(): void {
    this.closed = true;
    this.detach();
  }
}
import { extensionIdentity } from '../../shared/extension-identity';
