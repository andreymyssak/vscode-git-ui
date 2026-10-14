import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { withRepositoryOperation } from '../../src/extension/git/repository-operations';
import { readSourceControlOperation } from '../../src/extension/git/source-control/operation-state';
import { prepareSourceControlAbort } from '../../src/extension/git/source-control/prepared-abort';
import { selectedCommitFixture } from '../fixtures/selected-commit-changes';

async function stoppedPatch(kind: 'revert-files' | 'cherry-pick-files') {
  const f = await selectedCommitFixture();

  await f.runGit(['switch', '-c', 'source']);
  await writeFile(join(f.root, 'sample.txt'), 'source\n');
  await writeFile(join(f.root, '[added].txt'), 'added\n');
  await f.runGit(['add', '.']);
  await f.runGit(['commit', '-m', 'Source']);
  const sha = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await f.runGit(['switch', 'main']);
  if (kind === 'revert-files') await f.runGit(['cherry-pick', sha]);
  await writeFile(join(f.root, 'sample.txt'), 'target\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Target']);
  const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();

  await writeFile(join(f.root, 'unrelated-staged.txt'), 'staged\n');
  await f.runGit(['add', 'unrelated-staged.txt']);
  await writeFile(join(f.root, 'unrelated-staged.txt'), 'working\n');
  await writeFile(join(f.root, 'untracked.txt'), 'kept\n');
  const unrelatedIndex = await f.runGit([
    'ls-files',
    '--stage',
    '--',
    'unrelated-staged.txt',
  ]);
  const result = await f.operate('fixture', {
    kind,
    sha,
    parentSha: f.c,
    expectedBranch: 'main',
    expectedHeadSha: head,
    files: [
      {
        id: 'sample',
        status: 'modified',
        oldPath: 'sample.txt',
        newPath: 'sample.txt',
      },
      { id: 'new', status: 'added', oldPath: null, newPath: '[added].txt' },
    ],
  });

  expect(result.kind).toBe('conflict');
  const repository = f.access.repository('fixture');
  const lease = {
    root: repository.rootUri,
    cli: f.cli,
    current: () => repository,
    write: <T>(
      before: () => void,
      action: (cli: typeof f.cli, repo: typeof repository) => Promise<T>,
    ) =>
      withRepositoryOperation(f.cli, 'fixture', () => {
        before();

        return action(f.cli, repository);
      }),
  };
  const operation = (
    await readSourceControlOperation(f.cli, 'fixture', f.root)
  )[0];

  if (!operation) throw new Error('Missing recovery operation');
  const prepared = await prepareSourceControlAbort(
    lease,
    { id: 'fixture', token: operation.token },
    async () => {
      throw new Error('Selected patches must not call native abort');
    },
  );

  return { ...f, head, kind, prepared, operation, lease, unrelatedIndex };
}

test.each(['cherry-pick-files', 'revert-files'] as const)(
  'aborts a stopped %s after reload without touching unrelated index or worktree files',
  async (kind) => {
    const f = await stoppedPatch(kind);

    expect(f.operation.kind).toBe(kind);
    expect(f.operation.paths).toEqual(
      expect.arrayContaining(['sample.txt', '[added].txt']),
    );
    await f.prepared.write({ beforeWrite() {}, protectionPaths: () => [] });
    expect(await f.runGit(['ls-files', '-u'])).toBe('');
    expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('target\n');
    expect(
      await f.runGit(['ls-files', '--stage', '--', 'unrelated-staged.txt']),
    ).toBe(f.unrelatedIndex);
    expect(await readFile(join(f.root, 'unrelated-staged.txt'), 'utf8')).toBe(
      'working\n',
    );
    expect(await readFile(join(f.root, 'untracked.txt'), 'utf8')).toBe(
      'kept\n',
    );
    if (kind === 'cherry-pick-files')
      await expect(readFile(join(f.root, '[added].txt'))).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
    else
      expect(await readFile(join(f.root, '[added].txt'), 'utf8')).toBe(
        'added\n',
      );
    expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(f.head);
    expect(await readSourceControlOperation(f.cli, 'fixture', f.root)).toEqual(
      [],
    );
  },
);

test('keeps conflicted files when they change during Abort confirmation', async () => {
  const f = await stoppedPatch('revert-files');

  await writeFile(
    join(f.root, 'sample.txt'),
    'resolution typed after dialog opened\n',
  );
  await expect(
    f.prepared.write({ beforeWrite() {}, protectionPaths: () => [] }),
  ).rejects.toThrow(/changed/i);
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(
    'resolution typed after dialog opened\n',
  );
  expect(await f.runGit(['ls-files', '-u'])).not.toBe('');
});

test('keeps files with unsaved editors when aborting selected changes', async () => {
  const f = await stoppedPatch('revert-files');

  await expect(
    f.prepared.write({
      beforeWrite() {},
      protectionPaths: () => [join(f.root, 'sample.txt')],
    }),
  ).rejects.toThrow(/unsaved/i);
  expect(await f.runGit(['ls-files', '-u'])).not.toBe('');
});

test('rejects an Abort captured before the conflict was resolved and committed', async () => {
  const f = await stoppedPatch('revert-files');

  await writeFile(join(f.root, 'sample.txt'), 'resolved\n');
  await f.runGit(['add', 'sample.txt']);
  await f.runGit(['commit', '-m', 'Resolution']);
  await expect(
    f.prepared.write({ beforeWrite() {}, protectionPaths: () => [] }),
  ).rejects.toThrow(/changed|no longer/i);
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('resolved\n');
});

test.each(['merge', 'rebase', 'cherry-pick', 'revert'] as const)(
  'detects and aborts a real Git %s operation',
  async (kind) => {
    const f = await selectedCommitFixture();

    await f.runGit(['switch', '-c', 'source']);
    await writeFile(join(f.root, 'sample.txt'), 'source\n');
    await f.runGit(['add', 'sample.txt']);
    await f.runGit(['commit', '-m', 'Source']);
    const source = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    await f.runGit(['switch', 'main']);
    if (kind === 'revert') await f.runGit(['cherry-pick', source]);
    await writeFile(join(f.root, 'sample.txt'), 'target\n');
    await f.runGit(['add', 'sample.txt']);
    await f.runGit(['commit', '-m', 'Target']);
    const head = (await f.runGit(['rev-parse', 'HEAD'])).trim();

    await expect(
      f.runGit([
        kind,
        kind === 'merge' || kind === 'rebase' ? 'source' : source,
      ]),
    ).rejects.toThrow();
    const operation = (
      await readSourceControlOperation(f.cli, 'fixture', f.root)
    )[0];

    expect(operation?.kind).toBe(kind);
    if (!operation) throw new Error('Missing native operation');
    const repository = f.access.repository('fixture');
    const prepared = await prepareSourceControlAbort(
      {
        root: repository.rootUri,
        cli: f.cli,
        current: () => repository,
        write: <T>(
          before: () => void,
          action: (cli: typeof f.cli, repo: typeof repository) => Promise<T>,
        ) =>
          withRepositoryOperation(f.cli, 'fixture', () => {
            before();

            return action(f.cli, repository);
          }),
      },
      { id: 'fixture', token: operation.token },
      async (native) => {
        expect(native).toBe(kind);
        await f.runGit([native, '--abort']);
      },
    );

    await prepared.write({ beforeWrite() {}, protectionPaths: () => [] });
    expect(await readSourceControlOperation(f.cli, 'fixture', f.root)).toEqual(
      [],
    );
    expect((await f.runGit(['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await f.runGit(['symbolic-ref', 'HEAD'])).trim()).toBe(
      'refs/heads/main',
    );
    expect(await f.runGit(['status', '--porcelain'])).toBe('');
  },
);

test('legacy patch conflicts offer only path-scoped conflict discard', async () => {
  const f = await stoppedPatch('cherry-pick-files');
  const location = (
    await f.runGit([
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'git-ui-selected-changes.json',
    ])
  ).trim();
  const { unlink } = await import('node:fs/promises');

  await unlink(location);
  const operation = (
    await readSourceControlOperation(f.cli, 'fixture', f.root)
  )[0];

  expect(operation?.kind).toBe('conflicts');
  expect(operation?.paths).toEqual(['sample.txt']);
  if (!operation) throw new Error('Missing conflict');
  const prepared = await prepareSourceControlAbort(
    f.lease,
    { id: 'fixture', token: operation.token },
    async () => {
      throw new Error('Not a native Git sequence');
    },
  );

  await prepared.write({ beforeWrite() {}, protectionPaths: () => [] });
  expect(await f.runGit(['ls-files', '-u'])).toBe('');
  expect(await readFile(join(f.root, '[added].txt'), 'utf8')).toBe('added\n');
  expect(
    await f.runGit(['ls-files', '--stage', '--', 'unrelated-staged.txt']),
  ).toBe(f.unrelatedIndex);
});

test('an ordinary native apply failure does not create a later recovery operation', async () => {
  const f = await selectedCommitFixture();

  f.access.repository('fixture').apply = async () => {
    throw new Error('Native apply failed before touching files');
  };

  const result = await f.operate('fixture', {
    kind: 'revert-files',
    sha: f.c,
    parentSha: f.b,
    expectedBranch: 'main',
    expectedHeadSha: f.c,
    files: [
      {
        id: 'sample',
        status: 'modified',
        oldPath: 'sample.txt',
        newPath: 'sample.txt',
      },
    ],
  });

  expect(result.kind).toBe('error');
  await writeFile(join(f.root, 'sample.txt'), 'fresh unrelated edit\n');
  expect(await readSourceControlOperation(f.cli, 'fixture', f.root)).toEqual(
    [],
  );
});

test.each(['unstaged', 'removed'] as const)(
  'Abort also clears a recorded addition that was %s after the conflict',
  async (state) => {
    const f = await stoppedPatch('cherry-pick-files');

    await f.runGit(['reset', 'HEAD', '--', '[added].txt']);
    if (state === 'removed') {
      const { unlink } = await import('node:fs/promises');

      await unlink(join(f.root, '[added].txt'));
    }

    const prepared = await prepareSourceControlAbort(
      f.lease,
      { id: 'fixture', token: f.operation.token },
      async () => {
        throw new Error('Not native');
      },
    );

    await prepared.write({ beforeWrite() {}, protectionPaths: () => [] });
    expect(await f.runGit(['ls-files', '-u'])).toBe('');
    await expect(readFile(join(f.root, '[added].txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await f.runGit(['ls-files', '--stage', '--', 'unrelated-staged.txt']),
    ).toBe(f.unrelatedIndex);
    expect(await readSourceControlOperation(f.cli, 'fixture', f.root)).toEqual(
      [],
    );
  },
);

test('navigation cancellation after native patch success does not leave recovery state', async () => {
  const f = await selectedCommitFixture();
  const controller = new AbortController();
  const repository = f.access.repository('fixture');
  const apply = repository.apply;

  repository.apply = async (patch, options) => {
    await apply(patch, options);
    controller.abort(new Error('Navigation changed'));
  };

  const { applySelectedCommitChanges } =
    await import('../../src/extension/git/selected-commit-changes');

  await applySelectedCommitChanges(
    f.access,
    f.cli,
    'fixture',
    {
      kind: 'revert-files',
      sha: f.c,
      parentSha: f.b,
      expectedBranch: 'main',
      expectedHeadSha: f.c,
      files: [
        {
          id: 'sample',
          status: 'modified',
          oldPath: 'sample.txt',
          newPath: 'sample.txt',
        },
      ],
    },
    controller.signal,
  );
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('B\n');
  expect(await readSourceControlOperation(f.cli, 'fixture', f.root)).toEqual(
    [],
  );
});

test('successful native apply retires its pinned recovery file after repository close', async () => {
  const f = await selectedCommitFixture();
  const repository = f.access.repository('fixture');
  const original = repository.apply;
  let closed = false;
  let close: (repo: typeof repository) => unknown = () => {};

  const access = {
    ...f.access,
    api: {
      ...f.access.api,
      onDidCloseRepository: (listener: typeof close) => {
        close = listener;

        return { dispose() {} };
      },
    },
    repository: (id: string) => {
      if (closed) throw new Error('Repository closed');

      return f.access.repository(id);
    },
  };

  repository.apply = async (patch, options) => {
    await original(patch, options);
    closed = true;
    close(repository);
  };

  const cli = {
    run: (id: string, args: readonly string[]) => {
      if (closed) throw new Error('Repository closed');

      return f.cli.run(id, args);
    },
  };
  const { applySelectedCommitChanges } =
    await import('../../src/extension/git/selected-commit-changes');

  await applySelectedCommitChanges(access, cli, 'fixture', {
    kind: 'revert-files',
    sha: f.c,
    parentSha: f.b,
    expectedBranch: 'main',
    expectedHeadSha: f.c,
    files: [
      {
        id: 'sample',
        status: 'modified',
        oldPath: 'sample.txt',
        newPath: 'sample.txt',
      },
    ],
  });
  expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe('B\n');
  expect(await readSourceControlOperation(f.cli, 'fixture', f.root)).toEqual(
    [],
  );
});

test('oversized cancellation records are rejected before creating a recovery file', async () => {
  const f = await selectedCommitFixture();
  const { startSelectedChangeRecovery, readSelectedChangeRecovery } =
    await import('../../src/extension/git/selected-change-recovery');

  await expect(
    startSelectedChangeRecovery(f.cli, 'fixture', {
      root: f.root,
      kind: 'revert-files',
      head: f.c,
      branch: 'refs/heads/main',
      paths: Array.from(
        { length: 400 },
        (_, index) => `${'nested/'.repeat(100)}file-${index}.txt`,
      ),
    }),
  ).rejects.toThrow(/fewer files/i);
  expect(await readSelectedChangeRecovery(f.cli, 'fixture', f.root)).toBeNull();
});

test.each(['tracked', 'ignored'] as const)(
  'native Abort notices saved %s contents even when Git diff hides them',
  async (mode) => {
    const f = await selectedCommitFixture();

    await f.runGit(['switch', '-c', 'source']);
    await writeFile(join(f.root, 'sample.txt'), 'source\n');
    await f.runGit(['commit', '-am', 'Source']);
    await f.runGit(['switch', 'main']);
    await writeFile(join(f.root, 'sample.txt'), 'target\n');
    await f.runGit(['commit', '-am', 'Target']);
    await writeFile(
      join(f.root, '.git/info/attributes'),
      'sample.txt filter=drop\n',
    );
    await f.runGit(['config', 'filter.drop.clean', "sed '/^LOCAL/d'"]);
    await expect(f.runGit(['rebase', 'source'])).rejects.toThrow();
    if (mode === 'ignored') {
      await writeFile(join(f.root, '.git/info/exclude'), 'sample.txt\n');
      await f.runGit(['rm', '-f', 'sample.txt']);
      await writeFile(
        join(f.root, 'sample.txt'),
        'ignored resolution before confirmation\n',
      );
    }

    const repository = f.access.repository('fixture');
    const operation = (
      await readSourceControlOperation(f.cli, 'fixture', f.root)
    )[0];

    if (!operation) throw new Error('Missing rebase');
    const prepared = await prepareSourceControlAbort(
      {
        root: repository.rootUri,
        cli: f.cli,
        current: () => repository,
        write: <T>(
          before: () => void,
          action: (cli: typeof f.cli, repo: typeof repository) => Promise<T>,
        ) =>
          withRepositoryOperation(f.cli, 'fixture', () => {
            before();

            return action(f.cli, repository);
          }),
      },
      { id: 'fixture', token: operation.token },
      async (native) => {
        await f.runGit([native, '--abort']);
      },
    );
    const before = await f.runGit([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
    ]);
    const saved =
      (await readFile(join(f.root, 'sample.txt'), 'utf8')) +
      'LOCAL saved after confirmation\n';

    await writeFile(join(f.root, 'sample.txt'), saved);
    expect(
      await f.runGit(['diff', '--no-ext-diff', '--no-textconv', '--binary']),
    ).toBe(before);
    await expect(
      prepared.write({ beforeWrite() {}, protectionPaths: () => [] }),
    ).rejects.toThrow(/changed/i);
    expect(await readFile(join(f.root, 'sample.txt'), 'utf8')).toBe(saved);
    expect(
      (await readSourceControlOperation(f.cli, 'fixture', f.root))[0]?.kind,
    ).toBe('rebase');
  },
);
