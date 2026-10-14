import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { initialView } from '../../src/webview/app/model/state';
import { GraphAdapter } from '../../src/webview/pages/log/lib/graph/adapter';
import { HistoryRow } from '../../src/webview/pages/log/ui/history/HistoryRow';

test('commit menu exposes every selected identity and refuses a merge member', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const data = {
    ...initialView(),
    repository: {
      id: 'repo',
      label: 'Repo',
      rootUri: 'file:///repo',
      branch: 'main',
      headSha: a,
    },
    commits: [a, b].map((sha) => ({
      sha,
      parents: [],
      message: 'Change',
      authorName: null,
      authorEmail: null,
      authorDate: null,
      commitDate: null,
    })),
    selectedSha: a,
    commitRange: { selectedShas: [a, b], activeSha: a, anchorSha: b },
  };
  const props = {
    data,
    commit: data.commits[0]!,
    graph: new GraphAdapter().layout(data.commits, 'history')[0]!,
    index: 0,
    columns: [400, 100, 130] as [number, number, number],
    viewportHeight: 280,
    onIntent: vi.fn(),
    onNavigate: vi.fn(),
  };
  const view = render(<HistoryRow {...props} />);
  const context = () =>
    JSON.parse(screen.getByRole('row').getAttribute('data-vscode-context')!);

  expect(context()).toMatchObject({
    commitSha: a,
    commitShas: [a, b],
    commitSelectionCount: 2,
    commitCanCherryPick: true,
  });
  view.rerender(
    <HistoryRow
      {...props}
      data={{ ...data, details: { ...data.commits[0]!, parents: [a, b] } }}
    />,
  );
  expect(context().commitCanCherryPick).toBe(false);
  view.rerender(
    <HistoryRow
      {...props}
      data={{
        ...data,
        commits: [{ ...data.commits[0]!, parents: [a, b] }, data.commits[1]!],
      }}
    />,
  );
  expect(context().commitCanCherryPick).toBe(false);
});
