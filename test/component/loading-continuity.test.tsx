import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { initialView, reduceView } from '../../src/webview/app/model/state';
import { CommitDetails } from '../../src/webview/pages/log/ui/details/CommitDetails';

const commit = {
  sha: 'a'.repeat(40),
  parents: [],
  message: 'Previous commit',
  authorName: null,
  authorEmail: null,
  authorDate: null,
  commitDate: null,
};
const ready = {
  ...initialView(),
  repository: {
    id: 'one',
    rootUri: 'file:///one',
    label: 'One',
    branch: 'main',
    headSha: commit.sha,
  },
  selectedSha: commit.sha,
  details: commit,
  commits: [commit, { ...commit, sha: 'b'.repeat(40), message: 'Next commit' }],
  files: {
    root: [
      {
        id: 'old-file',
        status: 'added' as const,
        oldPath: null,
        newPath: 'old.txt',
      },
    ],
  },
};

test('retained commit files cannot activate while the next comparison loads', () => {
  const onIntent = vi.fn();
  const { rerender } = render(
    <CommitDetails data={ready} onIntent={onIntent} />,
  );

  const pending = reduceView(ready, {
    kind: 'select-commit',
    sha: 'b'.repeat(40),
  });

  rerender(<CommitDetails data={pending} onIntent={onIntent} />);
  expect(screen.getByText('Previous commit')).toBeVisible();
  const retainedFile = screen.getByRole('treeitem', {
    name: 'Added · old.txt',
  });

  fireEvent.click(retainedFile, { detail: 1 });
  fireEvent.doubleClick(retainedFile, { detail: 2 });
  fireEvent.keyDown(retainedFile, { key: 'Enter' });
  expect(onIntent).not.toHaveBeenCalled();
});

test('retained details never cross a repository switch', () => {
  const onIntent = vi.fn();
  const { rerender } = render(
    <CommitDetails data={ready} onIntent={onIntent} />,
  );
  const pending = reduceView(ready, {
    kind: 'select-commit',
    sha: 'b'.repeat(40),
  });

  rerender(<CommitDetails data={pending} onIntent={onIntent} />);
  expect(screen.getByText('Previous commit')).toBeVisible();
  rerender(
    <CommitDetails
      data={{
        ...initialView(),
        loading: true,
        repository: { ...ready.repository, id: 'two' },
      }}
      onIntent={onIntent}
    />,
  );
  expect(screen.queryByText('Previous commit')).not.toBeInTheDocument();
  expect(screen.queryByText('old.txt')).not.toBeInTheDocument();
});

test('a failed replacement comparison releases retained details and stops loading without inline errors', () => {
  const onIntent = vi.fn();
  const { container, rerender } = render(
    <CommitDetails data={ready} onIntent={onIntent} />,
  );
  const selected = reduceView(ready, {
    kind: 'select-commit',
    sha: 'b'.repeat(40),
  });
  const pending = { ...selected, details: ready.commits[1]! };

  rerender(<CommitDetails data={pending} onIntent={onIntent} />);
  expect(screen.getByText('Previous commit')).toBeVisible();
  rerender(
    <CommitDetails
      data={{ ...pending, fileErrors: { root: 'Could not read files' } }}
      onIntent={onIntent}
    />,
  );
  expect(screen.getByText('Next commit')).toBeVisible();
  expect(screen.queryByText('Previous commit')).not.toBeInTheDocument();
  expect(container.querySelector('#details')).not.toHaveAttribute('inert');
  expect(screen.queryByText('Could not read files')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry comparison' })).toBeNull();
  expect(container.querySelector('[role="group"]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  rerender(<CommitDetails data={pending} onIntent={onIntent} />);
  expect(screen.getByText('Next commit')).toBeVisible();
  expect(screen.queryByText('Previous commit')).not.toBeInTheDocument();
});

test('refreshing a retained merge requests all missing comparisons in the new generation', () => {
  const firstParent = 'c'.repeat(40);
  const secondParent = 'd'.repeat(40);
  const merge = { ...commit, parents: [firstParent, secondParent] };
  const data = {
    ...ready,
    generation: 1,
    details: merge,
    files: {},
  };
  const onIntent = vi.fn();
  const { rerender } = render(
    <CommitDetails data={data} onIntent={onIntent} />,
  );

  expect(onIntent.mock.calls.map(([intent]) => intent.body.parentSha)).toEqual([
    firstParent,
    secondParent,
  ]);
  const loaded = {
    ...data,
    selectedParentSha: secondParent,
    selectedFilePath: 'old.txt',
    files: { [firstParent]: [], [secondParent]: ready.files.root },
  };

  rerender(<CommitDetails data={loaded} onIntent={onIntent} />);
  rerender(
    <CommitDetails
      data={{
        ...loaded,
        generation: 2,
        details: null,
        files: {},
        loading: true,
      }}
      onIntent={onIntent}
    />,
  );
  expect(screen.getByText('Previous commit')).toBeVisible();
  onIntent.mockClear();
  rerender(
    <CommitDetails
      data={{
        ...loaded,
        generation: 2,
        files: { [secondParent]: ready.files.root },
      }}
      onIntent={onIntent}
    />,
  );
  expect(onIntent).toHaveBeenCalledExactlyOnceWith({
    kind: 'request',
    body: { kind: 'load-parent', sha: commit.sha, parentSha: firstParent },
  });
});
