import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { initialView } from '../../src/webview/app/model/state';
import { GraphAdapter } from '../../src/webview/pages/log/lib/graph/adapter';
import { HistoryRow } from '../../src/webview/pages/log/ui/history/HistoryRow';

test('row activation sends complete identity and renders literal subject', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();
  const sha = 'a'.repeat(40);
  const commit = {
    sha,
    parents: [],
    message: '<b>literal</b>',
    authorName: 'Author',
    authorEmail: null,
    authorDate: null,
    commitDate: null,
  };
  const data = {
    ...initialView(),
    commits: [commit],
    refs: [
      {
        id: 'refs/heads/topic',
        name: 'topic',
        kind: 'local' as const,
        sha,
        remote: null,
      },
    ],
  };
  const graph = new GraphAdapter().layout([commit], 'history')[0]!;
  const { container } = render(
    <HistoryRow
      data={data}
      commit={commit}
      graph={graph}
      index={0}
      columns={[400, 100, 130]}
      viewportHeight={280}
      onIntent={onIntent}
      onNavigate={vi.fn()}
    />,
  );
  const row = screen.getByRole('row', { name: /literal/ });

  await user.click(row);
  expect(onIntent).toHaveBeenLastCalledWith({ kind: 'select-commit', sha });
  await user.keyboard('{Enter}');
  expect(onIntent).toHaveBeenLastCalledWith({ kind: 'select-commit', sha });
  expect(
    screen.getByRole('group', { name: 'Local branch: topic' }),
  ).toBeInTheDocument();
  expect(container.querySelector('b')).toBeNull();
});

test('an optional revision cell shows an abbreviated value with the full identity available', () => {
  const sha = 'abcdef1234'.repeat(4);
  const commit = {
    sha,
    parents: [],
    message: 'Commit',
    authorName: 'Author',
    authorEmail: null,
    authorDate: null,
    commitDate: null,
  };

  render(
    <HistoryRow
      data={{ ...initialView(), commits: [commit], showHash: true }}
      commit={commit}
      graph={new GraphAdapter().layout([commit], 'history')[0]!}
      index={0}
      columns={[400, 100, 130]}
      viewportHeight={280}
      onIntent={vi.fn()}
      onNavigate={vi.fn()}
    />,
  );
  expect(screen.getAllByRole('cell')).toHaveLength(4);
  expect(screen.getByText('abcdef12')).toHaveAttribute('title', sha);
});

test('highlight descriptions reflect Git annotations without selecting a row', () => {
  const sha = 'a'.repeat(40);
  const commit = {
    sha,
    parents: ['b'.repeat(40), 'c'.repeat(40)],
    message: 'Merge',
    authorName: 'Author',
    authorEmail: 'me@example.test',
    authorDate: null,
    commitDate: null,
  };
  const data = {
    ...initialView(),
    annotations: {
      user: { name: '', email: 'me@example.test' },
      currentBranch: [sha],
    },
  };
  const props = {
    commit,
    graph: new GraphAdapter().layout([commit], 'history')[0]!,
    index: 0,
    columns: [400, 100, 130] as [number, number, number],
    viewportHeight: 280,
    onIntent: vi.fn(),
    onNavigate: vi.fn(),
  };
  const view = render(<HistoryRow {...props} data={data} />);
  const row = screen.getByRole('row');

  expect(row).toHaveAttribute('aria-selected', 'false');
  expect(row).toHaveAccessibleDescription(
    /Your commit.*Merge commit.*Current branch/,
  );
  view.rerender(
    <HistoryRow
      {...props}
      data={{
        ...data,
        presentation: {
          ...data.presentation,
          highlightMyCommits: false,
          highlightMergeCommits: false,
          highlightCurrentBranch: false,
        },
      }}
    />,
  );
  expect(row).not.toHaveAttribute('aria-description');
  view.rerender(
    <HistoryRow
      {...props}
      data={{
        ...data,
        presentation: {
          ...data.presentation,
          showAuthor: false,
          showDate: false,
        },
      }}
    />,
  );
  expect(screen.getAllByRole('cell')).toHaveLength(1);
});
