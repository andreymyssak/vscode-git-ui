import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { GitAdapter } from '../../src/extension/git/adapter';
import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import type { SquashRuntime } from '../../src/extension/git/squash-editor';
import { extensionIdentity } from '../../src/shared/extension-identity';
import type { CommitRangeTarget } from '../../src/shared/model';
import type { Fixture } from '../fixtures/repository';
import { createFixture } from '../fixtures/repository';

describe('queued squash through the installed Git API and bundled runtime', () => {
  let fixture: Fixture;
  let adapter: GitAdapter;
  let runtime: SquashRuntime;
  let storageDirectory: string;
  let owned: string;
  let id: string;
  let base: string;
  let target: CommitRangeTarget;

  beforeEach(async () => {
    assert.ok(process.versions.electron, 'exercise the actual VS Code host');
    fixture = await createFixture({ prefix: 'git-ui-native native squash ü ' });
    owned = await mkdtemp(join(tmpdir(), 'git-ui-native squash storage ü '));
    storageDirectory = join(owned, 'recovery');
    const extension = vscode.extensions.all.find(
      (entry) => entry.packageJSON.name === extensionIdentity.name,
    );

    assert.ok(extension);
    runtime = {
      executable: process.execPath,
      helperPath: join(extension.extensionPath, 'dist', 'squash-helper.cjs'),
    };
    await stat(runtime.helperPath);
    base = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    const shas: string[] = [];

    for (const [index, author] of ['Oldest', 'Middle', 'Newest'].entries()) {
      await writeFile(join(fixture.root, 'sample.txt'), `content ${index}\n`);
      await fixture.runGit(['add', 'sample.txt']);
      await fixture.runGit([
        'commit',
        '--author',
        `${author} <${author.toLowerCase()}@example.test>`,
        '-m',
        `${author} message`,
      ]);
      shas.push((await fixture.runGit(['rev-parse', 'HEAD'])).trim());
    }

    await fixture.runGit(['branch', 'retained', shas[0]!]);
    await fixture.runGit(['tag', 'retained', shas[1]!]);
    target = {
      shas: [...shas].reverse(),
      expectedBranch: 'main',
      expectedHeadSha: shas[2]!,
    };
    const access = await getGitApi();

    await access.api.openRepository(vscode.Uri.file(fixture.root));
    id = vscode.Uri.file(fixture.root).toString();
    await access.repository(id).status();
    adapter = await createGitAdapter(undefined, { runtime, storageDirectory });
  });

  afterEach(async () => {
    adapter?.dispose();
    await fixture?.dispose();
    if (owned) await rm(owned, { recursive: true, force: true, maxRetries: 5 });
  });

  it('preflights then performs one replacement with the literal message, oldest author and unchanged other refs', async () => {
    const originalTree = (
      await fixture.runGit(['rev-parse', 'HEAD^{tree}'])
    ).trim();
    const branch = await fixture.runGit(['rev-parse', 'refs/heads/retained']);
    const tag = await fixture.runGit(['rev-parse', 'refs/tags/retained']);
    const author = await fixture.runGit([
      'show',
      '-s',
      '--format=%an%x00%ae%x00%aI',
      target.shas.at(-1)!,
    ]);
    const prepared = await adapter.prepareSquash(id, target);

    assert.deepEqual(prepared.oldestToNewest, [...target.shas].reverse());
    const message = 'Native approved ü\n\n# literal comment\nBody   \n\n';
    const result = await adapter.operate(id, {
      kind: 'squash-commits',
      target,
      message,
    });

    assert.ok(result.kind === 'success', JSON.stringify(result));
    assert.equal(result.backend, 'cli');
    assert.equal(
      result.replacementSha,
      (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
    );
    assert.equal((await fixture.runGit(['rev-parse', 'HEAD^'])).trim(), base);
    assert.equal(
      (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim(),
      originalTree,
    );
    assert.equal(
      (await fixture.runGit(['rev-list', '--count', `${base}..HEAD`])).trim(),
      '1',
    );
    assert.equal(
      await fixture.runGit([
        'show',
        '-s',
        '--format=%an%x00%ae%x00%aI',
        'HEAD',
      ]),
      author,
    );
    assert.equal(
      await fixture.runGit(['rev-parse', 'refs/heads/retained']),
      branch,
    );
    assert.equal(
      await fixture.runGit(['rev-parse', 'refs/tags/retained']),
      tag,
    );
    const object = await fixture.runGit(['cat-file', 'commit', 'HEAD']);

    assert.equal(object.slice(object.indexOf('\n\n') + 2), message);
    assert.equal(await fixture.runGit(['status', '--porcelain=v1']), '');
    assert.deepEqual(await readdir(storageDirectory), []);
  });

  it('missing runtime disables squash while repository browsing remains usable', async () => {
    adapter.dispose();
    adapter = await createGitAdapter();
    await assert.rejects(
      () => adapter.prepareSquash(id, target),
      /runtime|configured|unavailable/i,
    );
    const page = await adapter.history(id, {
      scope: { kind: 'head' },
      text: '',
      cursor: null,
    });

    assert.ok(
      page.commits.some((commit) => commit.sha === target.expectedHeadSha),
    );
    const result = await adapter.operate(id, {
      kind: 'squash-commits',
      target,
      message: 'Approved',
    });

    assert.equal(result.kind, 'error');
    assert.equal(
      (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
      target.expectedHeadSha,
    );
  });

  it('an inaccessible recovery registry reports its failure without disabling history', async () => {
    adapter.dispose();
    await writeFile(storageDirectory, 'regular file, not recovery storage');
    adapter = await createGitAdapter(undefined, { runtime, storageDirectory });
    const page = await adapter.history(id, {
      scope: { kind: 'head' },
      text: '',
      cursor: null,
    });

    assert.ok(page.commits.length);
    await assert.rejects(() => adapter.prepareSquash(id, target), /recovery/i);
    const result = await adapter.operate(id, {
      kind: 'squash-commits',
      target,
      message: 'Approved',
    });

    assert.equal(result.kind, 'error');
    assert.equal(
      (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
      target.expectedHeadSha,
    );
    assert.equal(
      await readFile(storageDirectory, 'utf8'),
      'regular file, not recovery storage',
    );
  });

  for (const resolution of ['abort', 'continue'] as const)
    it(`a native signing failure keeps rebase inputs after adapter recreation until native ${resolution}`, async () => {
      const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
      const oldest = target.shas.at(-1)!;
      const author = await fixture.runGit([
        'show',
        '-s',
        '--format=%an%x00%ae%x00%aI',
        oldest,
      ]);
      const branch = await fixture.runGit(['rev-parse', 'refs/heads/retained']);
      const tag = await fixture.runGit(['rev-parse', 'refs/tags/retained']);
      const signer = join(owned, 'reject-signing');

      await writeFile(
        signer,
        '#!/bin/sh\necho "Fixture signing rejection" >&2\nexit 1\n',
      );
      await chmod(signer, 0o755);
      await fixture.runGit(['config', 'gpg.format', 'openpgp']);
      await fixture.runGit(['config', 'gpg.program', signer]);
      await fixture.runGit(['config', 'commit.gpgsign', 'true']);
      const result = await adapter.operate(id, {
        kind: 'squash-commits',
        target,
        message: 'Approved',
      });

      assert.equal(result.kind, 'error', JSON.stringify(result));
      const rebase = (
        await fixture.runGit([
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          'rebase-merge',
        ])
      ).trim();

      await stat(rebase);
      const entries = await readdir(storageDirectory);

      assert.equal(entries.length, 1);
      const input = join(storageDirectory, entries[0]!, 'input.json');

      await stat(input);
      adapter.dispose();
      adapter = await createGitAdapter(undefined, {
        runtime,
        storageDirectory,
      });
      await stat(input);
      const manifest = JSON.parse(await readFile(input, 'utf8'));

      assert.match(manifest.messageCommitSha, /^(?:[a-f\d]{40}|[a-f\d]{64})$/i);
      assert.equal(
        (
          await fixture.runGit([
            'show',
            '-s',
            '--format=%B',
            manifest.messageCommitSha,
          ])
        ).trim(),
        'Approved',
      );
      assert.equal(
        (
          await fixture.runGit(['rev-parse', `${manifest.messageCommitSha}^`])
        ).trim(),
        base,
      );

      assert.deepEqual(manifest, {
        operation: 'squash',
        replayShas: [...target.shas].reverse(),
        messageCommitSha: manifest.messageCommitSha,
        oldestToNewest: [...target.shas].reverse(),
        message: 'Approved',
      });
      if (resolution === 'abort') await fixture.runGit(['rebase', '--abort']);
      else {
        const continueRebase = () =>
          fixture.runGit(['-c', 'core.editor=true', 'rebase', '--continue']);
        const todo = join(rebase, 'git-rebase-todo');
        const markApplied = async (
          command: 'pick' | 'fixup' | 'fixup -C',
          sha: string,
        ) => {
          const contents = await readFile(todo, 'utf8');
          const replay = `${command} ${sha}`;

          if (!contents.split('\n')[0]?.startsWith(replay)) {
            // Some Git versions consume the manually committed entry themselves.
            // It must be the last completed action and absent from the remaining todo.
            const done = await readFile(join(rebase, 'done'), 'utf8');

            assert.equal(
              done.trimEnd().split('\n').at(-1)?.startsWith(replay),
              true,
              `Expected completed ${replay}. Done: ${done}. Todo: ${contents}`,
            );
            assert.equal(
              contents.split('\n').some((line) => line.startsWith(replay)),
              false,
            );

            return;
          }

          // Model a user editing Git's todo: the staged patch has already
          // been committed manually, so omit its rescheduled second replay.
          await writeFile(todo, contents.replace(replay, `drop ${sha}`));
        };

        assert.equal(
          (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
          base,
        );
        assert.equal(
          (await fixture.runGit(['write-tree'])).trim(),
          (await fixture.runGit(['rev-parse', `${oldest}^{tree}`])).trim(),
        );
        await assert.rejects(
          () =>
            fixture.runGit([
              '-c',
              'commit.gpgsign=false',
              '-c',
              'core.editor=true',
              'rebase',
              '--continue',
            ]),
          /staged changes/,
        );
        await stat(input);
        // These are explicit manual fixture recovery actions. The extension
        // preserves signing; Git retained -S despite a config=false override.
        await fixture.runGit(['commit', '--no-gpg-sign', '-C', oldest]);
        await markApplied('pick', oldest);
        await assert.rejects(continueRebase, /Fixture signing rejection/);
        await stat(input);
        assert.equal(
          (await fixture.runGit(['write-tree'])).trim(),
          (
            await fixture.runGit(['rev-parse', `${target.shas[1]!}^{tree}`])
          ).trim(),
        );
        await fixture.runGit([
          'commit',
          '--amend',
          '--no-gpg-sign',
          '-m',
          'Approved',
        ]);
        await markApplied('fixup', target.shas[1]!);
        await assert.rejects(continueRebase, /Fixture signing rejection/);
        await stat(input);
        assert.match(await readFile(todo, 'utf8'), /^fixup /);
        assert.equal((await fixture.runGit(['write-tree'])).trim(), tree);
        await fixture.runGit([
          'commit',
          '--amend',
          '--no-gpg-sign',
          '-m',
          'Approved',
        ]);
        await markApplied('fixup', target.shas[0]!);
        await assert.rejects(continueRebase, /Fixture signing rejection/);
        await fixture.runGit([
          'commit',
          '--amend',
          '--no-gpg-sign',
          '-m',
          'Approved',
        ]);
        await markApplied('fixup -C', manifest.messageCommitSha);
        await continueRebase();
      }

      await (await getGitApi()).repository(id).status();
      adapter.dispose();
      adapter = await createGitAdapter(undefined, {
        runtime,
        storageDirectory,
      });
      assert.deepEqual(await readdir(storageDirectory), []);
      if (resolution === 'abort')
        assert.equal(
          (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
          target.expectedHeadSha,
        );
      else {
        assert.equal(
          (
            await fixture.runGit(['rev-list', '--count', `${base}..HEAD`])
          ).trim(),
          '1',
        );
        assert.equal(
          (await fixture.runGit(['rev-parse', 'HEAD^'])).trim(),
          base,
        );
        assert.equal(
          (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim(),
          tree,
        );
        assert.equal(
          await fixture.runGit([
            'show',
            '-s',
            '--format=%an%x00%ae%x00%aI',
            'HEAD',
          ]),
          author,
        );
        assert.equal(
          (await fixture.runGit(['show', '-s', '--format=%B', 'HEAD'])).trim(),
          'Approved',
        );
        assert.equal(
          await fixture.runGit(['rev-parse', 'refs/heads/retained']),
          branch,
        );
        assert.equal(
          await fixture.runGit(['rev-parse', 'refs/tags/retained']),
          tag,
        );
        assert.equal(await fixture.runGit(['status', '--porcelain=v1']), '');
        assert.equal(
          (await fixture.runGit(['config', 'commit.gpgsign'])).trim(),
          'true',
        );
      }
    });

  it('intentional empty commits are retained when squashed in a linked worktree', async () => {
    const linked = join(owned, 'linked ü');

    await fixture.runGit(['worktree', 'add', '-b', 'linked', linked, base]);
    const git = (await getGitApi()).api.git.path;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = async (args: string[]) =>
      (
        await promisify(execFile)(git, args, {
          cwd: linked,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: join(fixture.root, 'isolated-gitconfig'),
            GIT_CONFIG_NOSYSTEM: '1',
          },
        })
      ).stdout;

    await run(['commit', '--allow-empty', '-m', 'Empty A']);
    const first = (await run(['rev-parse', 'HEAD'])).trim();

    await run(['commit', '--allow-empty', '-m', 'Empty B']);
    const second = (await run(['rev-parse', 'HEAD'])).trim();
    const access = await getGitApi();

    await access.api.openRepository(vscode.Uri.file(linked));
    const linkedId = vscode.Uri.file(linked).toString();

    await access.repository(linkedId).status();
    const result = await adapter.operate(linkedId, {
      kind: 'squash-commits',
      target: {
        shas: [second, first],
        expectedBranch: 'linked',
        expectedHeadSha: second,
      },
      message: 'Combined empties\n',
    });

    assert.ok(result.kind === 'success', JSON.stringify(result));
    assert.equal(
      (await run(['rev-list', '--count', `${base}..HEAD`])).trim(),
      '1',
    );
    assert.equal(
      (await run(['rev-parse', 'HEAD^{tree}'])).trim(),
      (await fixture.runGit(['rev-parse', `${base}^{tree}`])).trim(),
    );
    assert.equal(
      (await fixture.runGit(['rev-parse', 'main'])).trim(),
      target.expectedHeadSha,
    );
    assert.deepEqual(await readdir(storageDirectory), []);
  });

  it('a zero-net change and its reversal produce one empty replacement through the installed helper', async () => {
    await fixture.runGit(['revert', '--no-edit', ...target.shas]);
    const newest = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    const selected = (await fixture.runGit(['rev-list', `${base}..HEAD`]))
      .trim()
      .split('\n');
    const zeroNet: CommitRangeTarget = {
      shas: selected,
      expectedBranch: 'main',
      expectedHeadSha: newest,
    };
    const tree = (await fixture.runGit(['rev-parse', `${base}^{tree}`])).trim();
    const author = await fixture.runGit([
      'show',
      '-s',
      '--format=%an%x00%ae%x00%aI',
      selected.at(-1)!,
    ]);
    const refs = await fixture.runGit(['show-ref', 'retained']);

    await (await getGitApi()).repository(id).status();
    const snapshot = await adapter.prepareSquash(id, zeroNet);

    assert.equal(snapshot.treeSha, tree);
    const message = 'Native zero-net ü\n\n# preserved comment\n';
    const result = await adapter.operate(id, {
      kind: 'squash-commits',
      target: zeroNet,
      message,
    });

    assert.ok(result.kind === 'success', JSON.stringify(result));
    assert.equal(
      result.replacementSha,
      (await fixture.runGit(['rev-parse', 'HEAD'])).trim(),
    );
    assert.equal(
      (await fixture.runGit(['rev-list', '--count', `${base}..HEAD`])).trim(),
      '1',
    );
    assert.equal((await fixture.runGit(['rev-parse', 'HEAD^'])).trim(), base);
    assert.equal(
      (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim(),
      tree,
    );
    assert.equal(
      await fixture.runGit([
        'show',
        '-s',
        '--format=%an%x00%ae%x00%aI',
        'HEAD',
      ]),
      author,
    );
    assert.equal(await fixture.runGit(['show-ref', 'retained']), refs);
    const object = await fixture.runGit(['cat-file', 'commit', 'HEAD']);

    assert.equal(object.slice(object.indexOf('\n\n') + 2), message);
    assert.deepEqual(await readdir(storageDirectory), []);
  });
});
