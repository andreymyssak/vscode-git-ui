import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommitJumpQueue } from '../../src/extension/panel/commit-jump';

const older = { repositoryId: 'one', sha: 'a'.repeat(40) };
const newer = { repositoryId: 'two', sha: 'b'.repeat(40) };

afterEach(() => vi.useRealTimers());
describe('commit jump readiness', () => {
  it('preserves a rejected delivery even when its reason is undefined', async () => {
    const queue = new CommitJumpQueue();

    queue.attach(() => Promise.reject());
    await expect(queue.enqueue(older)).rejects.toBeUndefined();
    queue.dispose();
  });
  it('delivers only the latest target after the ready handshake', async () => {
    const queue = new CommitJumpQueue();
    const delivered: unknown[] = [];
    const first = queue.enqueue(older);
    const second = queue.enqueue(newer);

    queue.attach(async (target) => {
      delivered.push(target);
    });
    await Promise.all([first, second]);
    expect(delivered).toEqual([newer]);
    queue.dispose();
  });
  it('rejects pending work on view closure and accepts a new attachment', async () => {
    const queue = new CommitJumpQueue();
    const cancelled = expect(queue.enqueue(older)).rejects.toMatchObject({
      name: 'AbortError',
    });

    queue.detach();
    await cancelled;
    const delivered: unknown[] = [];
    const next = queue.enqueue(newer);

    queue.attach(async (target) => {
      delivered.push(target);
    });
    await next;
    expect(delivered).toEqual([newer]);
    queue.dispose();
  });
  it('rejects an initialization or navigation failure', async () => {
    const queue = new CommitJumpQueue();

    queue.attach(async () => {
      throw new Error('Commit is missing');
    });
    await expect(queue.enqueue(older)).rejects.toThrow('Commit is missing');
    const failing = expect(queue.enqueue(newer)).rejects.toThrow(
      'Initialization failed',
    );

    queue.detach(new Error('Initialization failed'));
    await failing;
    queue.dispose();
  });
  it('rejects every pending promise on final disposal', async () => {
    const queue = new CommitJumpQueue();
    const pending = expect(queue.enqueue(older)).rejects.toMatchObject({
      name: 'AbortError',
    });

    queue.dispose();
    await pending;
    await expect(queue.enqueue(newer)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  it('bounds readiness waiting to 15 seconds', async () => {
    vi.useFakeTimers();
    const queue = new CommitJumpQueue();
    const pending = expect(queue.enqueue(older)).rejects.toThrow(/ready/);

    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    queue.dispose();
  });
  it('does not impose the readiness timeout on an already running search', async () => {
    vi.useFakeTimers();
    const queue = new CommitJumpQueue();
    let release = () => {};

    const entered = new Promise<void>((resolve) =>
      queue.attach(async () => {
        resolve();
        await new Promise<void>((done) => {
          release = done;
        });
      }),
    );
    const pending = queue.enqueue(older);

    await entered;
    await vi.advanceTimersByTimeAsync(15_000);
    release();
    await pending;
    queue.dispose();
  });
});

it('drops a source that expired while waiting for the Log ready handshake', async () => {
  const queue = new CommitJumpQueue();
  let current = true;
  const delivered: unknown[] = [];
  const pending = queue.enqueue(older, () => current);

  current = false;
  queue.attach(async (target) => {
    delivered.push(target);
  });
  await pending;
  expect(delivered).toEqual([]);
  queue.dispose();
});
