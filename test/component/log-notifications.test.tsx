import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { PanelHeader } from '../../src/webview/app/layout/PanelHeader';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { CommitDetails } from '../../src/webview/pages/log/ui/details/CommitDetails';
import { HistoryToolbar } from '../../src/webview/pages/log/ui/search/HistoryToolbar';

test('invalid date ranges request a native error and retain the editable form', () => {
  const onIntent = vi.fn();

  render(<HistoryToolbar data={initialView()} onIntent={onIntent} />);
  fireEvent.click(screen.getByRole('button', { name: 'Date filter' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select period…' }));
  fireEvent.change(screen.getByLabelText('From', { exact: true }), {
    target: { value: '2026-10-07' },
  });
  fireEvent.change(screen.getByLabelText('To', { exact: true }), {
    target: { value: '2026-10-01' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));
  expect(onIntent).toHaveBeenCalledExactlyOnceWith({
    kind: 'request',
    body: { kind: 'invalid-date-filter' },
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(
    screen.queryByText('Start date must be on or before end date.'),
  ).toBeNull();
  expect(
    screen.getByRole('dialog', { name: 'Filter by committed date' }),
  ).toBeVisible();
  fireEvent.change(screen.getByLabelText('To', { exact: true }), {
    target: { value: '2026-10-08' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'filters',
    filters: {
      ...initialView().filters,
      date: { kind: 'range', from: '2026-10-07', to: '2026-10-08' },
    },
  });
});

test.each(['log', 'worktrees'] as const)(
  '%s read failures settle without status errors',
  (activeView) => {
    const { container } = render(
      <PanelHeader
        state={{ ...initialView(), activeView, error: 'Git read failed' }}
        request={vi.fn()}
        onLogIntent={vi.fn()}
        setActiveView={vi.fn()}
      />,
    );

    expect(screen.queryByText('Git read failed')).toBeNull();
    expect(screen.queryByText('No commits in these results.')).toBeNull();
    expect(container.querySelector('#status')).not.toBeVisible();
  },
);

test('operation failures leave no inline notice while setup guidance remains visible', () => {
  const state = reduceView(initialView(), {
    kind: 'host',
    message: {
      requestId: 'operation',
      repositoryId: '',
      generation: 0,
      body: {
        kind: 'operation',
        result: { kind: 'error', backend: 'cli', message: 'Checkout failed' },
      },
    },
  });
  const props = {
    request: vi.fn(),
    onLogIntent: vi.fn(),
    setActiveView: vi.fn(),
  };
  const { rerender } = render(<PanelHeader {...props} state={state} />);

  expect(screen.queryByText('Checkout failed')).toBeNull();
  rerender(
    <PanelHeader
      {...props}
      state={reduceView(state, {
        kind: 'host',
        message: {
          requestId: 'authors',
          repositoryId: '',
          generation: 0,
          body: {
            kind: 'notice',
            message: 'No authors were found in this repository.',
          },
        },
      })}
    />,
  );
  expect(
    screen.queryByText('No authors were found in this repository.'),
  ).toBeNull();
  rerender(
    <PanelHeader
      {...props}
      state={{
        ...initialView(),
        setup: 'untrusted',
        error: 'Invalid request during setup',
      }}
    />,
  );
  expect(
    screen.getByText('Trust this workspace through VS Code to use Git.'),
  ).toBeVisible();
  expect(screen.queryByText('Invalid request during setup')).toBeNull();
});

test('a failed selected commit stops loading without an inline fallback error', () => {
  const { container } = render(
    <CommitDetails
      data={{
        ...initialView(),
        selectedSha: 'a'.repeat(40),
        error: 'Details unavailable',
      }}
      onIntent={vi.fn()}
    />,
  );

  expect(container.querySelector('#details')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(screen.queryByText('Could not load this commit.')).toBeNull();
  expect(screen.queryByText('Loading commit…')).toBeNull();
});
