/** Callers wait for the latest read when their original read is superseded. */
export class RefreshCompletion {
  private latest: Promise<void> = Promise.resolve();

  async run(read: () => Promise<void>): Promise<void> {
    let pending = read();

    this.latest = pending;
    await pending;
    while (pending !== this.latest) {
      pending = this.latest;
      await pending;
    }
  }
}
