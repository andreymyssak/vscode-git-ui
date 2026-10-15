/** Callers wait for the latest read when their original read is superseded. */
export class RefreshCompletion {
  private latest: Promise<void> = Promise.resolve();
  private scheduled: {
    timer: ReturnType<typeof setTimeout>;
    finish(): void;
  } | null = null;

  schedule(read: () => Promise<void>): void {
    if (this.scheduled) return;
    const pending = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.scheduled = null;
        void this.run(read).then(resolve, reject);
      }, 100);

      this.scheduled = { timer, finish: resolve };
    });

    // An existing caller must also wait for native events still in the timer.
    void this.track(pending);
  }

  dispose(): void {
    this.consumeScheduled();
  }

  private consumeScheduled(): void {
    if (!this.scheduled) return;
    clearTimeout(this.scheduled.timer);
    this.scheduled.finish();
    this.scheduled = null;
  }

  run(read: () => Promise<void>): Promise<void> {
    // The explicit read observes the event that was waiting for its timer.
    this.consumeScheduled();

    return this.track(read());
  }

  private async track(pending: Promise<void>): Promise<void> {
    this.latest = pending;
    await pending;
    while (pending !== this.latest) {
      pending = this.latest;
      await pending;
    }
  }
}
