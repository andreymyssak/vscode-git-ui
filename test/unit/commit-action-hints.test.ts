import { expect, test } from 'vitest';

import type { CommitRecord, Reference } from '../../src/shared/model';
import {
  canDropLoadedRange,
  canEditLoadedCommit,
  canSquashLoadedRange,
} from '../../src/webview/pages/log/model/commit-action-hints';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const c = 'c'.repeat(40);
const d = 'd'.repeat(40);
const commits: CommitRecord[] = [a, b, c, d].map((sha, index) => ({
  sha,
  parents: index === 3 ? [] : [[b, c, d][index]!],
  message: 'Commit',
  authorName: null,
  authorEmail: null,
  authorDate: null,
  commitDate: null,
}));
const repository = {
  id: 'one',
  label: 'One',
  rootUri: 'file:///one',
  headSha: a,
  branch: 'main',
};
const range = (selectedShas: readonly string[]) => ({
  selectedShas,
  activeSha: selectedShas[0] ?? null,
  anchorSha: selectedShas[0] ?? null,
});
const eligible = {
  repository,
  commits,
  refs: [] as Reference[],
  commitRange: range([a, b, c]),
};

test('squash hint follows the loaded parent chain, independently of displayed row order and active member', () => {
  expect(canSquashLoadedRange(eligible)).toBe(true);
  expect(
    canSquashLoadedRange({
      ...eligible,
      commits: [commits[2]!, commits[0]!, commits[1]!],
      commitRange: { ...range([c, a, b]), activeSha: b },
    }),
  ).toBe(true);
});
test('single, duplicate, unloaded and root ranges cannot advertise squash', () => {
  for (const shas of [[], [a], [a, a], [a, 'f'.repeat(40)], [a, b, c, d]]) {
    expect(
      canSquashLoadedRange({ ...eligible, commitRange: range(shas) }),
      shas.join(','),
    ).toBe(false);
  }

  expect(
    canSquashLoadedRange({ ...eligible, commits: [commits[0]!, commits[2]!] }),
  ).toBe(false);
});
test('Drop advertises a single ordinary HEAD while preserving all other suffix restrictions', () => {
  expect(canDropLoadedRange({ ...eligible, commitRange: range([a]) })).toBe(
    true,
  );
  expect(canDropLoadedRange(eligible)).toBe(true);
  for (const shas of [[b], [a, c], [a, b, c, d], [a, a]])
    expect(canDropLoadedRange({ ...eligible, commitRange: range(shas) })).toBe(
      false,
    );
});
test('detached or missing HEAD cannot advertise a rewrite', () => {
  expect(canSquashLoadedRange({ ...eligible, repository: null })).toBe(false);
  expect(
    canSquashLoadedRange({
      ...eligible,
      repository: { ...repository, branch: null },
    }),
  ).toBe(false);
  expect(
    canSquashLoadedRange({
      ...eligible,
      repository: { ...repository, headSha: null },
    }),
  ).toBe(false);
});
test('root, merge, cyclic and malformed parent metadata reject the hint', () => {
  for (const parents of [[], [c, d], [a], ['abbreviated']]) {
    expect(
      canSquashLoadedRange({
        ...eligible,
        commits: commits.map((commit) =>
          commit.sha === b ? { ...commit, parents } : commit,
        ),
      }),
    ).toBe(false);
  }
});
test('a known remote tip on any range member disables squash while local and tag labels do not', () => {
  const ref: Reference = {
    id: 'refs/remotes/origin/main',
    name: 'origin/main',
    kind: 'remote',
    sha: b,
    remote: 'origin',
  };

  expect(canSquashLoadedRange({ ...eligible, refs: [ref] })).toBe(false);
  expect(
    canSquashLoadedRange({ ...eligible, refs: [{ ...ref, sha: d }] }),
  ).toBe(true);
  for (const kind of ['local', 'tag'] as const)
    expect(
      canSquashLoadedRange({
        ...eligible,
        refs: [{ ...ref, kind, remote: null }],
      }),
    ).toBe(true);
});
test('older and separated selections advertise squash on the loaded linear history', () => {
  for (const shas of [
    [b, c],
    [a, c],
  ])
    expect(
      canSquashLoadedRange({ ...eligible, commitRange: range(shas) }),
    ).toBe(true);
});

test('a merge at HEAD does not repeatedly scan all loaded history for visible row edit hints', () => {
  let inspected = 0;
  const loaded = Array.from({ length: 2000 }, (_, index) => {
    const sha = index.toString(16).padStart(40, '0');

    return {
      ...commits[0]!,
      get sha() {
        inspected++;

        return sha;
      },
      parents: index === 0 ? [b, c] : [c],
    };
  });
  const headSha = loaded[0]!.sha;
  const data = {
    ...eligible,
    repository: { ...repository, headSha },
    commits: loaded,
  };
  const visible = loaded.slice(0, 80).map((commit) => commit.sha);

  inspected = 0;
  expect(visible.map((sha) => canEditLoadedCommit(data, sha))).toEqual([
    true,
    ...Array<boolean>(79).fill(false),
  ]);
  expect(inspected).toBeLessThanOrEqual(loaded.length + visible.length * 4);
});
