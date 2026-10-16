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
  expect(screen.getByRole('region', { name: 'Changed files' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(
    screen
      .getByRole('region', { name: 'Changed files' })
      .querySelector(':scope > [aria-hidden="true"]'),
  ).toBeInTheDocument();
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

for (const outcome of ['loaded', 'failed', 'cleared', 'error'] as const)
  test(`Changed Files shows a progress line before details arrive and clears it when ${outcome}`, () => {
    const data = {
      ...initialView(),
      repository: ready.repository,
      selectedSha: commit.sha,
    };
    const onIntent = vi.fn();
    const view = render(<CommitDetails data={data} onIntent={onIntent} />);
    const line = () =>
      screen
        .getByRole('region', { name: 'Changed files' })
        .querySelector(':scope > [aria-hidden="true"]');

    expect(line()).toBeInTheDocument();
    expect(screen.queryByText('Loading commit…')).not.toBeInTheDocument();
    view.rerender(
      <CommitDetails data={{ ...data, details: commit }} onIntent={onIntent} />,
    );
    expect(line()).toBeInTheDocument();
    const settled =
      outcome === 'cleared'
        ? { ...data, selectedSha: null }
        : outcome === 'error'
          ? { ...data, error: 'Details unavailable' }
          : {
              ...data,
              details: commit,
              ...(outcome === 'loaded'
                ? { files: { root: [] } }
                : { fileErrors: { root: 'Files unavailable' } }),
            };

    view.rerender(<CommitDetails data={settled} onIntent={onIntent} />);
    expect(line()).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Changed files' }),
    ).toHaveAttribute('aria-busy', 'false');
  });

test('an older commit response cannot stop progress for the latest selection', () => {
  const onIntent = vi.fn();
  let state: ReturnType<typeof initialView> = ready;
  const view = render(<CommitDetails data={state} onIntent={onIntent} />);

  for (const sha of ['b'.repeat(40), commit.sha]) {
    state = reduceView(state, { kind: 'select-commit', sha });
    view.rerender(<CommitDetails data={state} onIntent={onIntent} />);
  }

  state = reduceView(state, {
    kind: 'host',
    message: {
      requestId: 'old-comparison',
      repositoryId: 'one',
      generation: 0,
      body: { kind: 'files', sha: 'b'.repeat(40), parentSha: null, files: [] },
    },
  });
  view.rerender(<CommitDetails data={state} onIntent={onIntent} />);
  expect(
    screen
      .getByRole('region', { name: 'Changed files' })
      .querySelector(':scope > [aria-hidden="true"]'),
  ).toBeInTheDocument();
});

test('Changed Files keeps its progress line until all requested merge comparisons settle', () => {
  const firstParent = 'c'.repeat(40);
  const secondParent = 'd'.repeat(40);
  const data = {
    ...ready,
    details: { ...commit, parents: [firstParent, secondParent] },
    files: { [firstParent]: ready.files.root },
  };
  const onIntent = vi.fn();
  const view = render(<CommitDetails data={data} onIntent={onIntent} />);
  const section = screen.getByRole('region', { name: 'Changed files' });

  expect(section).toHaveAttribute('aria-busy', 'true');
  expect(
    section.querySelector(':scope > [aria-hidden="true"]'),
  ).toBeInTheDocument();
  expect(screen.getByRole('complementary')).not.toHaveAttribute('inert');
  view.rerender(
    <CommitDetails
      data={{ ...data, fileErrors: { [secondParent]: 'Parent unavailable' } }}
      onIntent={onIntent}
    />,
  );
  expect(section).toHaveAttribute('aria-busy', 'false');
  expect(
    section.querySelector(':scope > [aria-hidden="true"]'),
  ).not.toBeInTheDocument();
});
