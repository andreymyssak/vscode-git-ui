import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, assert, beforeAll, expect, test } from 'vitest';

import { createOperations } from '../../src/extension/git/operations';
import { SquashRecovery } from '../../src/extension/git/squash-recovery';
import { buildHelperFixture } from '../fixtures/helper-build';
import { createSquashFixture } from '../fixtures/squash-repository';

let helperPath: string;
let built: Awaited<ReturnType<typeof buildHelperFixture<'helper'>>>;

beforeAll(async () => {
  built = await buildHelperFixture({
    helper: 'src/extension/git/squash-helper.ts',
  });
  helperPath = built.paths.helper;
});
afterAll(async () => {
  await built?.dispose();
});
for (const kind of ['root', 'merge'] as const) {
  test(`latest ${kind} message edit retains the tree, parents and author without replay`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    try {
      f.access.repository('fixture').status = async () => {};

      let head = f.initial;

      if (kind === 'merge') {
        const tree = (await f.runGit(['rev-parse', `${f.c}^{tree}`])).trim();

        head = (
          await f.runGit([
            'commit-tree',
            tree,
            '-p',
            f.c,
            '-p',
            f.a,
            '-m',
            'Merge',
          ])
        ).trim();
      }

      await f.runGit(['reset', '--hard', head]);
      const metadata = ['show', '-s', '--format=%T%n%P%n%an%n%ae%n%aI'];
      const before = await f.runGit([...metadata, head]);
      const run = createOperations(f.access, f.cli, {
        updateDiverged: async () => null,
        remoteCheckout: async () => null,
      });
      const result = await run('fixture', {
        kind: 'edit-commit-message',
        sha: head,
        expectedHeadSha: head,
        expectedBranch: 'main',
        message: 'Reviewed latest message',
      });

      assert.ok(result.kind === 'success', JSON.stringify(result));
      expect(result.replacementSha).not.toBe(head);
      expect(await f.runGit([...metadata, 'HEAD'])).toBe(before);
      expect(
        (await f.runGit(['show', '-s', '--format=%s', 'HEAD'])).trim(),
      ).toBe('Reviewed latest message');
      expect((await f.runGit(['rev-parse', 'retained-branch'])).trim()).toBe(
        f.a,
      );
    } finally {
      await f.dispose();
    }
  });
}

for (const kind of ['edit', 'squash', 'separated squash'] as const) {
  test(
    `${kind} replays older linear history and preserves descendants, final tree and unrelated refs`,
    async (t) => {
      const fixture = await createSquashFixture();

      t.onTestFinished(() => fixture.dispose());
      try {
        // Independent files make a separated reorder conflict-free and observable.
        await fixture.runGit(['reset', '--hard', fixture.initial]);
        const commits: string[] = [];

        for (const name of ['a', 'b', 'c', 'd']) {
          await writeFile(join(fixture.root, `${name}.txt`), `${name}\n`);
          await fixture.runGit(['add', '.']);
          await fixture.runGit(['commit', '-m', name]);
          commits.push((await fixture.runGit(['rev-parse', 'HEAD'])).trim());
        }

        const oldHead = commits[3]!;
        const tree = (
          await fixture.runGit(['rev-parse', 'HEAD^{tree}'])
        ).trim();
        const retained = await fixture.runGit(['rev-parse', 'retained-branch']);

        fixture.access.repository('fixture').status = async () => {};

        fixture.access.repository('fixture').getCommit = async () => ({
          hash: oldHead,
          message: 'd',
          parents: [commits[2]!],
        });
        const run = createOperations(
          fixture.access,
          fixture.cli,
          {
            updateDiverged: async () => null,
            remoteCheckout: async () => null,
          },
          {
            runtime: { executable: process.execPath, helperPath },
            recovery: new SquashRecovery(
              join(fixture.directory, 'recovery'),
              fixture.cli,
            ),
          },
        );
        const result = await run(
          'fixture',
          kind === 'edit'
            ? {
                kind: 'edit-commit-message',
                sha: commits[1]!,
                expectedBranch: 'main',
                expectedHeadSha: oldHead,
                message: 'Edited older\n\nBody',
              }
            : {
                kind: 'squash-commits',
                message: 'Combined older',
                target: {
                  expectedBranch: 'main',
                  expectedHeadSha: oldHead,
                  shas:
                    kind === 'squash'
                      ? [commits[1]!, commits[0]!]
                      : [commits[2]!, commits[0]!],
                },
              },
        );

        expect(result.kind, JSON.stringify(result)).toBe('success');
        expect(
          (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim(),
        ).toBe(tree);
        expect(await fixture.runGit(['symbolic-ref', '--short', 'HEAD'])).toBe(
          'main\n',
        );
        expect(await fixture.runGit(['rev-parse', 'retained-branch'])).toBe(
          retained,
        );
        const messages = (
          await fixture.runGit([
            'log',
            '--reverse',
            '--format=%s',
            `${fixture.initial}..HEAD`,
          ])
        )
          .trim()
          .split('\n');

        expect(messages).toStrictEqual(
          kind === 'edit'
            ? ['a', 'Edited older', 'c', 'd']
            : kind === 'squash'
              ? ['Combined older', 'c', 'd']
              : ['Combined older', 'b', 'd'],
        );
        assert.ok(result.kind === 'success' && result.replacementSha);
        expect(
          (
            await fixture.runGit([
              'show',
              '-s',
              '--format=%s',
              result.replacementSha,
            ])
          ).trim(),
        ).toBe(kind === 'edit' ? 'Edited older' : 'Combined older');
      } finally {
        await fixture.dispose();
      }
    },
    process.platform === 'win32' ? 90000 : 30000,
  );
}

test('separated squash retains its approved message through Git Continue after a conflict', async (t) => {
  const f = await createSquashFixture();

  t.onTestFinished(() => f.dispose());
  try {
    f.access.repository('fixture').status = async () => {};

    const run = createOperations(
      f.access,
      f.cli,
      { updateDiverged: async () => null, remoteCheckout: async () => null },
      {
        runtime: { executable: process.execPath, helperPath },
        recovery: new SquashRecovery(join(f.directory, 'recovery'), f.cli),
      },
    );
    const result = await run('fixture', {
      kind: 'squash-commits',
      target: { ...f.target, shas: [f.a, f.c] },
      message: 'Approved across conflict',
    });

    expect(result.kind, JSON.stringify(result)).toBe('conflict');
    await writeFile(join(f.root, 'sample.txt'), 'C\n');
    await f.runGit(['add', 'sample.txt']);
    // Replaying retained B conflicts after the approved squash has been committed.
    await expect(
      f.runGit(['-c', 'core.editor=true', 'rebase', '--continue']),
    ).rejects.toThrow();
    expect(
      (await f.runGit(['diff', '--name-only', '--diff-filter=U'])).trim(),
    ).toBe('sample.txt');
    const rebase = (
      await f.runGit([
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'rebase-merge',
      ])
    ).trim();

    expect((await stat(rebase)).isDirectory()).toBe(true);
    await writeFile(join(f.root, 'sample.txt'), 'C\n');
    await f.runGit(['add', 'sample.txt']);
    await f.runGit(['-c', 'core.editor=true', 'rebase', '--continue']);
    const messages = (
      await f.runGit(['log', '--reverse', '--format=%s', `${f.initial}..HEAD`])
    )
      .trim()
      .split('\n');

    expect(messages).toStrictEqual(['Approved across conflict']);
    expect((await f.runGit(['rev-parse', 'HEAD^{tree}'])).trim()).toBe(
      (await f.runGit(['rev-parse', `${f.c}^{tree}`])).trim(),
    );
  } finally {
    await f.dispose();
  }
});
for (const obstruction of [
  'merge descendant',
  'published ancestor',
  'stale HEAD',
  'dirty index',
] as const) {
  test(`older message edit refuses ${obstruction} without writing history`, async (t) => {
    const f = await createSquashFixture();

    t.onTestFinished(() => f.dispose());
    try {
      f.access.repository('fixture').status = async () => {};

      let head = f.c;

      if (obstruction === 'merge descendant') {
        const tree = (await f.runGit(['rev-parse', 'HEAD^{tree}'])).trim();

        head = (
          await f.runGit([
            'commit-tree',
            tree,
            '-p',
            f.c,
            '-p',
            f.a,
            '-m',
            'Merge',
          ])
        ).trim();
        await f.runGit(['reset', '--hard', head]);
      }

      if (obstruction === 'published ancestor')
        await f.runGit(['update-ref', 'refs/remotes/origin/topic', f.b]);
      if (obstruction === 'stale HEAD')
        await f.runGit(['commit', '--allow-empty', '-m', 'New HEAD']);
      if (obstruction === 'dirty index') {
        await writeFile(join(f.root, 'sample.txt'), 'Dirty');
        await f.runGit(['add', 'sample.txt']);
      }

      const before = await f.state();
      const run = createOperations(
        f.access,
        f.cli,
        { updateDiverged: async () => null, remoteCheckout: async () => null },
        {
          runtime: { executable: process.execPath, helperPath },
          recovery: new SquashRecovery(join(f.directory, 'recovery'), f.cli),
        },
      );
      const result = await run('fixture', {
        kind: 'edit-commit-message',
        sha: f.a,
        expectedHeadSha: head,
        expectedBranch: 'main',
        message: 'Must not apply',
      });

      expect(result.kind, JSON.stringify(result)).toBe('error');
      expect(await f.state()).toStrictEqual(before);
    } finally {
      await f.dispose();
    }
  });
}
