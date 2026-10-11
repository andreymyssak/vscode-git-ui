import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { expect, test, vi } from 'vitest';

import { initialView } from '../../src/webview/app/model/state';
import { CommitDetails } from '../../src/webview/pages/log/ui/details/CommitDetails';
import { changedFiles } from '../fixtures/changed-files';

const sha = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const commit = {
  sha,
  parents: [parent, 'c'.repeat(40), 'd'.repeat(40)],
  message: '<script>text</script>',
  authorName: '<b>author</b>',
  authorEmail: null,
  authorDate: null,
  commitDate: null,
};

for (const [authorDate, commitDate] of [
  [null, '2026-08-20T12:19:00Z'],
  ['2026-08-19T12:19:00Z', '2026-08-20T12:19:00Z'],
  ['2026-08-19T12:19:00Z', null],
] as const) {
  test(`commit metadata shows the committed date without substituting author time, ${commitDate}, ${authorDate}`, () => {
    const { container } = render(
      <CommitDetails
        data={{
          ...initialView(),
          details: { ...commit, authorDate, commitDate },
        }}
        onIntent={vi.fn()}
      />,
    );

    if (commitDate)
      expect(container.querySelector('time')).toHaveAttribute(
        'dateTime',
        commitDate,
      );
    else {
      expect(screen.getByText('Committed at an unknown date')).toBeVisible();
      expect(container.querySelector('time')).toBeNull();
    }

    expect(container.querySelectorAll('time')).toHaveLength(commitDate ? 1 : 0);
  });
}

test('author email is a native mail link with repository text confined to its recipient', () => {
  const email = 'person+test@example.test?subject=Injected';

  render(
    <CommitDetails
      data={{ ...initialView(), details: { ...commit, authorEmail: email } }}
      onIntent={vi.fn()}
    />,
  );
  expect(screen.getByRole('link', { name: `<${email}>` })).toHaveAttribute(
    'href',
    'mailto:' + encodeURIComponent(email),
  );
});

test('commit reference groups follow the displayed revision and update when references move', () => {
  const base = {
    ...initialView(),
    repository: {
      id: 'one',
      rootUri: 'file:///one',
      label: 'One',
      branch: 'main',
      headSha: sha,
    },
    details: commit,
    refs: [
      {
        id: 'refs/heads/main',
        name: 'main',
        kind: 'local' as const,
        sha,
        remote: null,
      },
      {
        id: 'refs/heads/topic',
        name: 'topic',
        kind: 'local' as const,
        sha,
        remote: null,
      },
      {
        id: 'refs/remotes/origin/main',
        name: 'origin/main',
        kind: 'remote' as const,
        sha,
        remote: 'origin',
      },
      {
        id: 'refs/tags/v1.0',
        name: 'v1.0',
        kind: 'tag' as const,
        sha,
        remote: null,
      },
      {
        id: 'refs/tags/elsewhere',
        name: 'elsewhere',
        kind: 'tag' as const,
        sha: parent,
        remote: null,
      },
    ],
  };
  const view = render(<CommitDetails data={base} onIntent={vi.fn()} />);
  const references = screen.getByRole('group', {
    name: 'Branches and tags at this commit',
  });

  expect(references).toHaveTextContent('HEAD');
  expect(references).toHaveTextContent('main, topic');
  expect(references).toHaveTextContent('origin/main');
  expect(references).toHaveTextContent('v1.0');
  expect(references).not.toHaveTextContent('elsewhere');
  view.rerender(
    <CommitDetails
      data={{
        ...base,
        repository: { ...base.repository, headSha: parent },
        refs: base.refs.map((ref) => ({ ...ref, sha: parent })),
      }}
      onIntent={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole('group', { name: 'Branches and tags at this commit' }),
  ).toBeNull();
});

test('ordinary changed files show compact counted folders and preserve manual collapse', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();
  const data = {
    ...initialView(),
    selectedSha: sha,
    details: { ...commit, parents: [parent] },
    files: { [parent]: changedFiles },
  };
  const { rerender } = render(
    <CommitDetails data={data} onIntent={onIntent} />,
  );

  expect(screen.getByRole('treeitem', { name: /6 files/ })).toBeVisible();
  const folder = screen.getByRole('treeitem', { name: 'common 4 files' });

  expect(folder).toHaveAttribute('aria-expanded', 'true');
  expect(
    screen.getByRole('treeitem', { name: 'config/rush 2 files' }),
  ).toBeVisible();
  const file = screen.getByRole('treeitem', {
    name: 'Modified · pnpm-lock.yaml',
  });

  expect(file).toBeVisible();
  await user.click(file);
  await waitFor(() =>
    expect(onIntent).toHaveBeenLastCalledWith({
      kind: 'request',
      body: { kind: 'open-file', fileId: 'lock-file', preview: true },
    }),
  );
  await user.click(folder);
  expect(folder).toHaveAttribute('aria-expanded', 'false');
  rerender(
    <CommitDetails data={{ ...data, generation: 5 }} onIntent={onIntent} />,
  );
  expect(folder).toHaveAttribute('aria-expanded', 'false');
  expect(file).not.toBeVisible();
});

test('the same path in two merge comparisons selects only its actual parent', () => {
  const path = 'same.txt';
  const second = commit.parents[1]!;

  render(
    <CommitDetails
      data={{
        ...initialView(),
        selectedSha: sha,
        selectedParentSha: second,
        selectedFilePath: path,
        details: commit,
        files: {
          [parent]: [
            { id: 'first', status: 'modified', oldPath: path, newPath: path },
          ],
          [second]: [
            { id: 'second', status: 'modified', oldPath: path, newPath: path },
          ],
        },
      }}
      onIntent={vi.fn()}
    />,
  );
  const selected = screen.getAllByRole('treeitem', { selected: true });

  expect(selected).toHaveLength(1);
  expect(selected[0]).toHaveAttribute('data-file', 'second');
});
test('all parent counts load once while collapsed and failed comparisons remain quiet', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();
  const data = { ...initialView(), selectedSha: sha, details: commit };
  const { rerender } = render(
    <StrictMode>
      <CommitDetails data={data} onIntent={onIntent} />
    </StrictMode>,
  );

  expect(onIntent.mock.calls.map(([intent]) => intent.body.parentSha)).toEqual(
    commit.parents,
  );
  expect(screen.queryByRole('button', { name: 'Retry comparison' })).toBeNull();
  rerender(
    <StrictMode>
      <CommitDetails data={{ ...data, showHash: true }} onIntent={onIntent} />
    </StrictMode>,
  );
  expect(onIntent).toHaveBeenCalledTimes(3);
  rerender(
    <StrictMode>
      <CommitDetails
        data={{
          ...data,
          fileErrors: { [parent]: 'Parent object unavailable.' },
        }}
        onIntent={onIntent}
      />
    </StrictMode>,
  );
  expect(screen.queryByRole('button', { name: 'Retry comparison' })).toBeNull();
  expect(screen.queryByText('Parent object unavailable.')).toBeNull();
  expect(screen.queryByText('Unavailable')).toBeNull();
  expect(onIntent).toHaveBeenCalledTimes(3);
  const file = {
    id: 'owned-file-id',
    status: 'renamed' as const,
    oldPath: 'old.txt',
    newPath: 'new.txt',
  };

  rerender(
    <StrictMode>
      <CommitDetails
        data={{ ...data, files: { [parent]: [file] } }}
        onIntent={onIntent}
      />
    </StrictMode>,
  );
  const node = screen.getByRole('treeitem', { name: 'Renamed · new.txt' });

  await user.click(node);
  await waitFor(() =>
    expect(onIntent).toHaveBeenLastCalledWith({
      kind: 'request',
      body: { kind: 'open-file', fileId: 'owned-file-id', preview: true },
    }),
  );
  await user.keyboard('{Enter}');
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'request',
    body: { kind: 'open-file', fileId: 'owned-file-id', preview: false },
  });
  await user.dblClick(node);
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'request',
    body: { kind: 'open-file', fileId: 'owned-file-id', preview: false },
  });
  expect(
    screen.getAllByRole('treeitem', { name: /Changes to Parent/ }),
  ).toHaveLength(3);
});
test('loaded collapsed comparisons show real counts and opening an empty parent does not load again', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();
  const second = commit.parents[1]!;
  const third = commit.parents[2]!;
  const data = {
    ...initialView(),
    selectedSha: sha,
    details: commit,
    files: {
      [parent]: changedFiles,
      [second]: [],
      [third]: changedFiles.slice(0, 2),
    },
  };

  render(<CommitDetails data={data} onIntent={onIntent} />);
  expect(
    screen.getByRole('treeitem', { name: /Changes to Parent 2.*0 files/ }),
  ).toHaveAttribute('aria-expanded', 'false');
  expect(
    screen.getByRole('treeitem', { name: /Changes to Parent 3.*2 files/ }),
  ).toBeVisible();
  await user.click(
    screen.getByRole('treeitem', { name: /Changes to Parent 2/ }),
  );
  expect(
    screen.getByText('No changes compared with this parent.'),
  ).toBeVisible();
  expect(onIntent).not.toHaveBeenCalled();
});
test('details render commit and author text literally with root changes', () => {
  const data = {
    ...initialView(),
    details: { ...commit, parents: [] },
    files: { root: [] },
  };
  const { container } = render(
    <CommitDetails data={data} onIntent={vi.fn()} />,
  );

  expect(screen.getByText('<script>text</script>')).toBeInTheDocument();
  expect(screen.getByText('<b>author</b>')).toBeInTheDocument();
  expect(
    screen.getByRole('treeitem', { name: /Root changes/ }),
  ).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('b')).toBeNull();
});
test('restoring a nested file opens its merge parent but later updates preserve manual collapse', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();
  const secondParent = commit.parents[1]!;
  const file = {
    id: 'second-parent-file',
    status: 'modified' as const,
    oldPath: 'src/nested/file.ts',
    newPath: 'src/nested/file.ts',
  };
  const data = {
    ...initialView(),
    selectedSha: sha,
    details: commit,
    files: { [parent]: [], [secondParent]: [file] },
  };
  const restored = {
    ...data,
    selectedParentSha: secondParent,
    selectedFilePath: 'src/nested/file.ts',
  };
  const { container, rerender, unmount } = render(
    <CommitDetails data={data} onIntent={onIntent} />,
  );
  const parentGroup = container.querySelector<HTMLDetailsElement>(
    `[data-parent="${secondParent}"]`,
  )!;

  expect(parentGroup.open).toBe(false);
  rerender(<CommitDetails data={restored} onIntent={onIntent} />);
  expect(parentGroup.open).toBe(true);
  expect(
    parentGroup.querySelector<HTMLDetailsElement>('[data-folder="src/nested"]')
      ?.open,
  ).toBe(true);
  expect(
    screen.getByRole('treeitem', { name: 'Modified · file.ts' }),
  ).toHaveAttribute('aria-selected', 'true');
  await user.click(parentGroup.querySelector('summary')!);
  expect(parentGroup.open).toBe(false);
  rerender(
    <CommitDetails data={{ ...restored, generation: 5 }} onIntent={onIntent} />,
  );
  expect(parentGroup.open).toBe(false);
  unmount();
  const recreated = render(
    <CommitDetails data={restored} onIntent={onIntent} />,
  );

  expect(
    recreated.container.querySelector<HTMLDetailsElement>(
      `[data-parent="${secondParent}"]`,
    )?.open,
  ).toBe(true);
});
