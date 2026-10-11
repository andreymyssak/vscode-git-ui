import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, assert, beforeAll, expect, test } from 'vitest';

import type { GitApiAccess, GitRepository } from '../../src/extension/git/api';
import { updateBranch } from '../../src/extension/git/branch-update';
import type { GitCli } from '../../src/extension/git/cli';
import { createOperations } from '../../src/extension/git/operations';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-ui-native-update-state-'));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
for (const change of [
  'checkout',
  'upstream',
  'tip',
  'dirty',
  'submodule',
] as const) {
  test(`Update rejects a ${change} change at the final execution boundary`, async () => {
    const sha = 'a'.repeat(40);
    let final = false;
    let pulls = 0;
    const cli = {
      run: async (
        _id: string,
        args: string[],
        _signal?: AbortSignal,
        before?: () => Promise<void>,
      ) => {
        if (args[0] === 'merge') {
          final = true;
          await before?.();
          pulls++;

          return '';
        }

        if (args[0] === 'rev-parse')
          return args.includes('--git-path') ? join(root, args.at(-1)!) : sha;
        if (args[0] === 'rev-list') return '0\t1';
        if (args[0] === 'symbolic-ref')
          return final && change === 'checkout'
            ? 'refs/heads/topic\n'
            : 'refs/heads/main\n';
        if (args[0] === 'for-each-ref')
          return `refs/heads/main\0${final && change === 'tip' ? 'b'.repeat(40) : sha}\0${final && change === 'upstream' ? 'refs/remotes/other/main' : 'refs/remotes/origin/main'}\0origin\0refs/heads/main\n`;
        if (
          args[0] === 'status' &&
          final &&
          (change === 'dirty' ||
            (change === 'submodule' &&
              args.includes('--ignore-submodules=none')))
        )
          return ' M file\0';

        return '';
      },
    } as unknown as GitCli;

    await expect(
      updateBranch(
        {
          rootUri: { fsPath: root },
          fetch: async () => {},
          getCommit: async () => ({
            hash: 'b'.repeat(40),
            message: '',
            parents: [],
          }),
        } as unknown as GitRepository,
        cli,
        'one',
        {
          kind: 'update-branch',
          refId: 'refs/heads/main',
          expectedSha: sha,
          expectedUpstream: 'refs/remotes/origin/main',
        },
        { updateDiverged: async () => null },
      ),
    ).rejects.toThrow(/changed|local changes/);
    expect(final).toBe(true);
    expect(pulls).toBe(0);
  });
}

const oldTip = 'a'.repeat(40);
const fetchedTip = 'b'.repeat(40);
const resultTip = 'c'.repeat(40);

function updateFixture() {
  const state = {
    checkout: 'refs/heads/main',
    head: oldTip,
    tip: oldTip,
    upstream: 'refs/remotes/origin/topic',
    counts: '0\t1',
    dirty: false,
    fetches: 0,
    occupied: false,
    symbolic: '',
    detachedWorktree: false,
    writes: [] as string[],
    finalChange: null as (() => void) | null,
  };
  const repo = {
    rootUri: { fsPath: root },
    fetch: async () => {
      state.fetches++;
    },
    getCommit: async (ref: string) => ({
      hash: ref === 'HEAD' ? state.head : fetchedTip,
      message: '',
      parents: [],
    }),
    checkout: async (name: string) => {
      state.writes.push(`checkout ${name}`);
      state.checkout = 'refs/heads/' + name;
      state.head = name === 'topic' ? state.tip : oldTip;
    },
    merge: async () => {
      state.writes.push('merge');
      state.tip = resultTip;
      state.head = resultTip;
    },
    rebase: async () => {
      state.writes.push('rebase');
      state.tip = resultTip;
      state.head = resultTip;
    },
  } as unknown as GitRepository;
  const cli = {
    run: async (_id, args, _signal, before) => {
      if (args[0] === 'update-ref') {
        state.finalChange?.();
        await before?.();
        state.writes.push('update-ref');
        state.tip = args.at(-2)!;
      }

      if (args[0] === 'symbolic-ref') return state.checkout;
      if (args[0] === 'rev-parse')
        return args.includes('--git-path')
          ? join(root, args.at(-1)!)
          : args.at(-1) === 'HEAD^{commit}'
            ? state.head
            : oldTip;
      if (args[0] === 'for-each-ref')
        return `refs/heads/topic\0${state.tip}\0${state.upstream}\0origin\0refs/heads/topic\0${state.symbolic}\n`;
      if (args[0] === 'rev-list') return state.counts;
      if (args[0] === 'worktree')
        return `worktree ${join(root, 'other')}\0${state.detachedWorktree ? 'detached' : `branch ${state.occupied ? 'refs/heads/topic' : 'refs/heads/main'}`}\0\0`;
      if (args[0] === 'status') return state.dirty ? ' M sample.txt\0' : '';

      return '';
    },
  } as GitCli;
  const action = {
    kind: 'update-branch' as const,
    refId: 'refs/heads/topic',
    expectedSha: oldTip,
    expectedUpstream: state.upstream,
  };

  return { state, repo, cli, action };
}

test('Update fast-forwards another tracked branch without changing checkout', async () => {
  const f = updateFixture();
  let prompts = 0;

  await updateBranch(f.repo, f.cli, 'one', f.action, {
    updateDiverged: async () => {
      prompts++;

      return null;
    },
  });
  expect(f.state.tip).toBe(fetchedTip);
  expect(f.state.checkout).toBe('refs/heads/main');
  expect(f.state.head).toBe(oldTip);
  expect(f.state.writes).toStrictEqual(['update-ref']);
  expect(prompts).toBe(0);
});
for (const when of ['before Update', 'at the ref write'] as const) {
  test(`Another branch fast-forward preserves local edits ${when}`, async () => {
    const f = updateFixture();

    if (when === 'before Update') f.state.dirty = true;
    else
      f.state.finalChange = () => {
        f.state.dirty = true;
      };

    await updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async () => assert.fail('This can fast-forward'),
    });
    expect(f.state.tip).toBe(fetchedTip);
    expect(f.state.checkout).toBe('refs/heads/main');
    expect(f.state.head).toBe(oldTip);
    expect(f.state.dirty).toBe(true);
    expect(f.state.writes).toStrictEqual(['update-ref']);
  });
}

for (const current of [false, true])
  for (const counts of ['0\t0', '3\t0']) {
    test(`Update fetches dirty ${current ? 'current' : 'other'} equal/ahead history (${counts}) without a write`, async () => {
      const f = updateFixture();

      f.state.counts = counts;
      f.state.dirty = true;
      if (current) f.state.checkout = 'refs/heads/topic';
      await updateBranch(f.repo, f.cli, 'one', f.action, {
        updateDiverged: async () => assert.fail('No divergence'),
      });
      expect(f.state.writes).toStrictEqual([]);
      expect(f.state.fetches).toBe(1);
      expect(f.state.dirty).toBe(true);
      expect(f.state.tip).toBe(oldTip);
    });
  }

test('a dirty current divergent Update can fetch and Cancel without changing local work', async () => {
  const f = updateFixture();

  f.state.checkout = 'refs/heads/topic';
  f.state.counts = '1\t2';
  f.state.dirty = true;
  expect(
    await updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async () => null,
    }),
  ).toBe(null);
  expect(f.state.fetches).toBe(1);
  expect(f.state.writes).toStrictEqual([]);
  expect(f.state.dirty).toBe(true);
});
for (const [counts, choice, expected] of [
  ['0\t0', null, '"topic" is already up to date.'],
  ['0\t5', null, 'Updated "topic": 5 incoming commits.'],
  ['1\t2', 'rebase', 'Updated "topic" with Rebase: 2 incoming commits.'],
  ['1\t2', 'merge', 'Updated "topic" with Merge: 2 incoming commits.'],
] as const) {
  test(`Update reports its actual ${choice ?? counts} outcome`, async () => {
    const f = updateFixture();

    f.state.counts = counts;
    if (choice) f.state.checkout = 'refs/heads/topic';
    const result = await updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async () => choice,
    });

    expect(result?.message).toBe(expected);
  });
}

for (const choice of ['merge', 'rebase', null] as const) {
  test(`Current divergent Update explicitly chooses ${choice ?? 'Cancel'}`, async () => {
    const f = updateFixture();

    f.state.counts = '1\t2';
    f.state.checkout = 'refs/heads/topic';
    await updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async (target) => {
        expect(target).toStrictEqual({
          branch: 'topic',
          upstream: 'origin/topic',
          currentBranch: 'topic',
        });

        return choice;
      },
    });
    expect(f.state.writes).toStrictEqual(choice ? [choice] : []);
    expect(f.state.checkout).toBe('refs/heads/topic');
    expect(f.state.tip).toBe(choice ? resultTip : oldTip);
  });
}

for (const choice of ['checkout', null] as const) {
  test(`Another divergent branch offers ${choice ?? 'Cancel'} without merging or rebasing`, async () => {
    const f = updateFixture();

    f.state.counts = '1\t2';
    const result = await updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async (target) => {
        expect(target.currentBranch).toBe('main');

        return choice;
      },
    });

    expect(result).toStrictEqual(
      choice
        ? {
            backend: 'api',
            message: 'Checked out "topic". Choose Update Branch to update it.',
          }
        : null,
    );
    expect(f.state.writes).toStrictEqual(choice ? ['checkout topic'] : []);
    expect(f.state.checkout).toBe(
      choice ? 'refs/heads/topic' : 'refs/heads/main',
    );
    expect(f.state.tip).toBe(oldTip);
    expect(f.state.head).toBe(oldTip);
  });
}

test('Cancelling another divergent branch works with local edits', async () => {
  const f = updateFixture();
  let prompts = 0;

  f.state.counts = '1\t2';
  f.state.dirty = true;
  expect(
    await updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async () => {
        prompts++;

        return null;
      },
    }),
  ).toBe(null);
  expect(prompts).toBe(1);
  expect(f.state.dirty).toBe(true);
  expect(f.state.writes).toStrictEqual([]);
});
for (const choice of ['merge', 'rebase'] as const) {
  test(`Another divergent branch cannot silently ${choice}`, async () => {
    const f = updateFixture();

    f.state.counts = '1\t2';
    await expect(
      updateBranch(f.repo, f.cli, 'one', f.action, {
        updateDiverged: async () => choice,
      }),
    ).rejects.toThrow();
    expect(f.state.writes).toStrictEqual([]);
    expect(f.state.checkout).toBe('refs/heads/main');
  });
}

for (const change of [
  'checkout',
  'tip',
  'upstream',
  'dirty',
  'occupied',
] as const) {
  test(`Divergent Update rejects ${change} changed during its native choice`, async () => {
    const f = updateFixture();

    f.state.counts = '1\t1';
    await expect(
      updateBranch(f.repo, f.cli, 'one', f.action, {
        updateDiverged: async () => {
          if (change === 'checkout') f.state.checkout = 'refs/heads/elsewhere';
          if (change === 'tip') f.state.tip = resultTip;
          if (change === 'upstream')
            f.state.upstream = 'refs/remotes/other/topic';
          if (change === 'dirty') f.state.dirty = true;
          if (change === 'occupied') f.state.occupied = true;

          return 'checkout';
        },
      }),
    ).rejects.toThrow();
    expect(f.state.writes).toStrictEqual([]);
  });
}

test('Another branch Update rechecks worktree occupancy at the ref write', async () => {
  const f = updateFixture();

  f.state.finalChange = () => {
    f.state.occupied = true;
  };

  await expect(
    updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async () => null,
    }),
  ).rejects.toThrow();
  expect(f.state.writes).toStrictEqual([]);
});
test('A failed native rebase leaves its branch checked out without restoring or retrying', async () => {
  const f = updateFixture();

  f.state.counts = '1\t1';
  f.state.checkout = 'refs/heads/topic';
  f.repo.rebase = async () => {
    f.state.writes.push('rebase');
    throw new Error('Native conflict');
  };

  await expect(
    updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async () => 'rebase',
    }),
  ).rejects.toThrow(/Native conflict/);
  expect(f.state.checkout).toBe('refs/heads/topic');
  expect(f.state.writes).toStrictEqual(['rebase']);
});
for (const changed of ['dirty', 'checkout'] as const) {
  test(`Current rebase reports ${changed} changed after the native write without switching branches`, async () => {
    const f = updateFixture();
    const rebase = f.repo.rebase;

    f.state.counts = '1\t1';
    f.state.checkout = 'refs/heads/topic';
    f.repo.rebase = async (sha) => {
      await rebase(sha);
      if (changed === 'dirty') f.state.dirty = true;
      if (changed === 'checkout') f.state.checkout = 'refs/heads/elsewhere';
    };

    await expect(
      updateBranch(f.repo, f.cli, 'one', f.action, {
        updateDiverged: async () => 'rebase',
      }),
    ).rejects.toThrow(/local changes|checkout changed/);
    expect(f.state.writes).toStrictEqual(['rebase']);
  });
}

test('Update rejects a symbolic local branch rather than moving its checked-out destination', async () => {
  const f = updateFixture();

  f.state.symbolic = 'refs/heads/main';
  await expect(
    updateBranch(f.repo, f.cli, 'one', f.action, {
      updateDiverged: async () => null,
    }),
  ).rejects.toThrow(/symbolic/);
  expect(f.state.writes).toStrictEqual([]);
});
test('Update refuses a branch owned by a detached bisect in another worktree', async (t) => {
  const f = updateFixture();
  const directory = await mkdtemp(
    join(tmpdir(), 'git-ui-native-update-bisect-'),
  );

  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const run = f.cli.run;

  f.state.detachedWorktree = true;
  f.cli.run = async (id, args, ...rest) =>
    args[0] === '-C'
      ? join(
          directory,
          args.at(-1) === 'BISECT_START' ? 'BISECT_START' : 'absent',
        )
      : run(id, args, ...rest);
  await writeFile(join(directory, 'BISECT_START'), 'topic\n');
  try {
    await expect(
      updateBranch(f.repo, f.cli, 'one', f.action, {
        updateDiverged: async () => null,
      }),
    ).rejects.toThrow(/bisected/);
    expect(f.state.writes).toStrictEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Update rejects a changed upstream before fetching or writing', async () => {
  const sha = 'a'.repeat(40);
  let fetches = 0;
  const access = {
    api: {},
    repositories: () => [],
    repository: () => ({
      rootUri: { fsPath: root },
      fetch: async () => {
        fetches++;
      },
      status: async () => {},
    }),
  } as unknown as GitApiAccess;
  const run = createOperations(
    access,
    {
      run: async (_id, args) => {
        if (args.includes('--git-common-dir')) return tmpdir();
        if (args[0] === 'symbolic-ref') return 'refs/heads/topic\n';
        if (args[0] === 'rev-parse') return sha;
        if (args[0] === 'for-each-ref')
          return `refs/heads/main\0${sha}\0refs/remotes/other/main\0other\0refs/heads/main\n`;

        return '';
      },
    },
    { updateDiverged: async () => null, remoteCheckout: async () => null },
  );
  const result = await run('one', {
    kind: 'update-branch',
    refId: 'refs/heads/main',
    expectedSha: sha,
    expectedUpstream: 'refs/remotes/origin/main',
  });

  expect(result.kind).toBe('error');
  expect(result.kind === 'error' ? result.message : '').toMatch(
    /upstream changed/,
  );
  expect(fetches).toBe(0);
});
