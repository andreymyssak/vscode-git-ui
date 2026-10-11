import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { GitAdapter } from '../../src/extension/git/adapter';
import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import type { Fixture } from '../fixtures/repository';
import {
  commitLinearHistory,
  commitWithDate,
  createFixture,
} from '../fixtures/repository';

describe('history and identity', () => {
  let fixture: Fixture;
  let adapter: GitAdapter;
  let id: string;
  let initial: string;
  let prefix: string;

  before(async () => {
    fixture = await createFixture({ prefix: 'git-ui-native history ü ' });
    initial = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    prefix = initial.slice(0, 7);
    const parent = await commitLinearHistory(
      fixture,
      initial,
      Array.from({ length: 220 }, (_, index) => {
        const i = index + 1;
        const message =
          i === 80
            ? 'Literal [x].* MixedCase'
            : i === 120
              ? `Mention ${prefix}`
              : `Commit ${i}`;

        return { message, date: `${1700000000 - i} +0000` };
      }),
    );

    await fixture.runGit(['update-ref', 'refs/heads/main', parent]);
    await fixture.runGit(['update-ref', 'refs/heads/-n10', initial]);
    await fixture.runGit(['branch', 'тема', initial]);
    await fixture.runGit(['tag', 'тема', parent]);
    await fixture.runGit(['tag', 'release', initial]);
    const access = await getGitApi();

    await access.api.openRepository(vscode.Uri.file(fixture.root));
    adapter = await createGitAdapter();
    id = vscode.Uri.file(fixture.root).toString();
  });
  after(async () => {
    adapter?.dispose();
    await fixture?.dispose();
  });
  it('200-item pages preserve topological Git order and pinned tips', async () => {
    const input = { scope: { kind: 'head' as const }, text: '', cursor: null };
    const first = await adapter.history(id, input);

    assert.equal(first.commits.length, 200);
    assert.deepEqual(first.annotations?.user, {
      name: '',
      email: 'fixture@example.test',
    });
    assert.deepEqual(
      first.annotations?.currentBranch,
      first.commits.map((commit) => commit.sha),
    );
    const expected = (
      await fixture.runGit(['log', '--topo-order', '--format=%H', 'HEAD'])
    )
      .trim()
      .split('\n');

    assert.deepEqual(
      first.commits.map((commit) => commit.sha),
      expected.slice(0, 200),
    );
    try {
      await fixture.runGit(['update-ref', 'refs/heads/main', initial]);
      const second = await adapter.history(id, {
        ...input,
        cursor: first.nextCursor,
      });

      assert.deepEqual(
        second.annotations?.currentBranch,
        second.commits.map((commit) => commit.sha),
      );

      assert.deepEqual(
        [...first.commits, ...second.commits].map((commit) => commit.sha),
        expected,
      );
    } finally {
      await fixture.runGit([
        'update-ref',
        'refs/heads/main',
        expected[0] ?? initial,
      ]);
    }
  });
  it('message punctuation is literal and case insensitive', async () => {
    const result = await adapter.history(id, {
      scope: { kind: 'all' },
      text: '[x].* mixedcase',
      cursor: null,
    });

    assert.deepEqual(
      result.commits.map((commit) => commit.message.trim()),
      ['Literal [x].* MixedCase'],
    );
  });
  it('branch filtering includes shared ancestors and All includes unrelated branch history', async () => {
    const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
    const other = (
      await fixture.runGit([
        'commit-tree',
        tree,
        '-m',
        'Unrelated branch commit',
      ])
    ).trim();

    await fixture.runGit(['update-ref', 'refs/heads/other', other]);
    try {
      const selected = await adapter.history(id, {
        scope: { kind: 'ref', refId: 'refs/heads/тема' },
        text: '',
        cursor: null,
      });
      const all = await adapter.history(id, {
        scope: { kind: 'all' },
        text: '',
        cursor: null,
      });
      const revisited = await adapter.history(id, {
        scope: { kind: 'ref', refId: 'refs/heads/тема' },
        text: '',
        cursor: null,
      });

      assert.deepEqual(
        selected.commits.map((commit) => commit.sha),
        [initial],
      );
      assert.ok(all.commits.some((commit) => commit.sha === other));
      assert.deepEqual(selected.annotations?.currentBranch, [initial]);
      assert.ok(!all.annotations?.currentBranch.includes(other));
      assert.deepEqual(revisited.commits, selected.commits);
      assert.equal(
        (await fixture.runGit(['branch', '--show-current'])).trim(),
        'main',
      );
    } finally {
      await fixture.runGit(['update-ref', '-d', 'refs/heads/other']);
    }
  });
  it('hash and message union retains Git order and deduplicates', async () => {
    const result = await adapter.history(id, {
      scope: { kind: 'ref', refId: 'refs/heads/-n10' },
      text: prefix,
      cursor: null,
    });

    assert.equal(result.commits.length, 2);
    assert.equal(result.commits[1]?.sha, initial);
    assert.equal(result.commits[0]?.message.trim(), `Mention ${prefix}`);
  });
  it('tags detached HEAD Unicode and option-like names resolve safely', async () => {
    const special = await adapter.resolve(id, '-n10');

    assert.equal(special.kind, 'commit');
    if (special.kind === 'commit') assert.equal(special.commit.sha, initial);
    assert.equal((await adapter.resolve(id, 'тема')).kind, 'choices');
    assert.equal((await adapter.resolve(id, 'release')).kind, 'commit');
    const hash = await adapter.resolve(id, initial.slice(0, 8));

    assert.equal(hash.kind, 'commit');
    try {
      await fixture.runGit(['checkout', '--detach', initial]);
      const access = await getGitApi();

      await access.repository(id).status();
      const page = await adapter.history(id, {
        scope: { kind: 'head' },
        text: '',
        cursor: null,
      });

      assert.equal(page.commits[0]?.sha, initial);
    } finally {
      await fixture.runGit(['checkout', 'main']);
    }
  });
  it('ambiguous hash prefix requests more characters without writing', async () => {
    const before = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
    const tree = (await fixture.runGit(['rev-parse', 'HEAD^{tree}'])).trim();
    const format = (
      await fixture.runGit(['rev-parse', '--show-object-format'])
    ).trim();

    assert.ok(format === 'sha1' || format === 'sha256');
    const date = '1700000000 +0000';

    type Candidate = { message: string; sha: string };

    const prefixes = new Map<string, Candidate>();
    let collision: readonly [Candidate, Candidate] | undefined;

    // Find matching four-character prefixes without launching Git for each candidate.
    for (let index = 0; index <= 0x10000 && !collision; index++) {
      const message = `Unreachable ${index}`;
      const contents =
        `tree ${tree}\nparent ${before}\n` +
        `author Fixture <fixture@example.test> ${date}\n` +
        `committer Fixture <fixture@example.test> ${date}\n\n${message}\n`;
      const sha = createHash(format)
        .update(`commit ${Buffer.byteLength(contents)}\0`)
        .update(contents)
        .digest('hex');
      const candidate = { message, sha };
      const previous = prefixes.get(sha.slice(0, 4));

      if (previous && previous.sha !== sha) collision = [previous, candidate];
      else prefixes.set(sha.slice(0, 4), candidate);
    }

    assert.ok(collision, 'fixture must contain a commit prefix collision');
    // Git writes real objects and verifies the hashes computed above.
    for (const candidate of collision)
      assert.equal(
        await commitWithDate(fixture, tree, before, candidate.message, date),
        candidate.sha,
      );
    const prefix = collision[0].sha.slice(0, 4);

    assert.equal(collision[1].sha.slice(0, 4), prefix);
    assert.equal((await adapter.resolve(id, prefix)).kind, 'ambiguous');
    assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), before);
  });
  it('repository events revoke old cursors and aborted reads cannot return results', async () => {
    // Finish fixture checkout/discovery before subscribing to the event under test.
    await (await getGitApi()).repository(id).status();
    const subscription = adapter.subscribe(id, () => {});

    try {
      const input = { scope: { kind: 'all' as const }, text: '', cursor: null };
      const page = await adapter.history(id, input);

      assert.ok(page.nextCursor);
      await fixture.runGit(['commit', '--allow-empty', '-m', 'History event']);
      await (await getGitApi()).repository(id).status();
      await assert.rejects(
        () => adapter.history(id, { ...input, cursor: page.nextCursor }),
        /History changed/,
      );
      const cancellation = new AbortController();

      cancellation.abort();
      await assert.rejects(() =>
        adapter.history(id, input, cancellation.signal),
      );
    } finally {
      subscription.dispose();
    }
  });
  it('unknown input does not alter repository state', async () => {
    const before = await fixture.runGit(['status', '--porcelain=v1']);

    assert.equal(
      (await adapter.resolve(id, '--upload-pack=bad')).kind,
      'missing',
    );
    assert.equal(await fixture.runGit(['status', '--porcelain=v1']), before);
    await writeFile(join(fixture.root, 'untouched.txt'), 'local');
    const withLocalWork = await fixture.runGit(['status', '--porcelain=v1']);

    assert.equal((await adapter.resolve(id, 'abc')).kind, 'missing');
    assert.equal(
      await fixture.runGit(['status', '--porcelain=v1']),
      withLocalWork,
    );
    assert.equal(
      await readFile(join(fixture.root, 'untouched.txt'), 'utf8'),
      'local',
    );
  });
});
