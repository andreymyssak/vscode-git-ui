import { expect, test } from 'vitest';

import {
  commitLinearHistory,
  commitWithDate,
  createFixture,
} from '../fixtures/repository';

test('batched fixture history preserves commit-tree identities without changing refs or files', async () => {
  const fixture = await createFixture({ prefix: 'gnu-linear-identity-' });

  try {
    const parent = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
    const refs = await fixture.runGit(['show-ref']);
    const revisions = [
      { message: 'Literal [x].* MixedCase', date: '1700000000 +0000' },
      { message: 'Multiline ü\n\nSecond paragraph', date: '1699999999 +0230' },
      { message: 'Last revision', date: '1699999998 -0530' },
    ];
    let expected = parent;

    for (const { message, date } of revisions)
      expected = await commitWithDate(fixture, tree, expected, message, date);

    expect(await commitLinearHistory(fixture, parent, revisions)).toBe(
      expected,
    );
    expect(await commitLinearHistory(fixture, parent, [])).toBe(parent);
    expect(await fixture.runGit(['show-ref'])).toBe(refs);
    expect((await fixture.runGit(['rev-parse', 'HEAD'])).trim()).toBe(parent);
    expect(await fixture.runGit(['status', '--porcelain'])).toBe('');
  } finally {
    await fixture.dispose();
  }
});

test('batched fixture history creates all 220 unchanged-tree revisions in order', async () => {
  const fixture = await createFixture({ prefix: 'gnu-linear-history-' });

  try {
    const parent = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
    const revisions = Array.from({ length: 220 }, (_, index) => ({
      message: `Commit ${index + 1}`,
      date: `${1700000000 - index} +0000`,
    }));
    const head = await commitLinearHistory(fixture, parent, revisions);
    const history = (
      await fixture.runGit([
        'log',
        '--reverse',
        '--format=%H%x00%P%x00%T%x00%at%x00%s',
        `${parent}..${head}`,
      ])
    )
      .trim()
      .split('\n');

    expect(history).toHaveLength(220);
    let previous = parent;

    for (const [index, row] of history.entries()) {
      const [sha, actualParent, actualTree, time, message] = row.split('\0');

      expect(actualParent).toBe(previous);
      expect(actualTree).toBe(tree);
      expect(time).toBe(String(1700000000 - index));
      expect(message).toBe(`Commit ${index + 1}`);
      previous = sha!;
    }

    expect(previous).toBe(head);
    expect((await fixture.runGit(['rev-parse', 'HEAD'])).trim()).toBe(parent);
    expect(await fixture.runGit(['for-each-ref', 'refs/fixture'])).toBe('');
  } finally {
    await fixture.dispose();
  }
});
