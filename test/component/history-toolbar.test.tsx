import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { initialView } from '../../src/webview/app/model/state';
import { LogPage } from '../../src/webview/pages/log';

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => vi.unstubAllGlobals());

test('both active filters clear only their own value and return keyboard focus', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();
  const data = initialView();

  data.filters = {
    regex: true,
    matchCase: true,
    author: {
      kind: 'selected',
      identities: [{ name: 'Alice', email: 'alice@example.test' }],
    },
    date: '7d',
  };
  render(<LogPage data={data} onIntent={onIntent} />);
  for (const [name, filters] of [
    ['User', { ...data.filters, author: { kind: 'all' } }],
    ['Date', { ...data.filters, date: 'all' }],
  ] as const) {
    const trigger = screen.getByRole('button', { name: `${name} filter` });

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(
      screen.getByRole('button', {
        name: `Clear ${name.toLowerCase()} filter`,
      }),
    );
    expect(onIntent).toHaveBeenLastCalledWith({ kind: 'filters', filters });
    expect(trigger).toHaveFocus();
  }
});

test('history author/date controls emit explicit filters and use the native author picker', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();

  render(<LogPage data={initialView()} onIntent={onIntent} />);
  await user.click(screen.getByRole('button', { name: 'User filter' }));
  await user.click(screen.getByRole('button', { name: /^Me$/ }));
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'filters',
    filters: {
      regex: false,
      matchCase: false,
      author: { kind: 'me' },
      date: 'all',
    },
  });
  await user.click(screen.getByRole('button', { name: 'User filter' }));
  await user.click(screen.getByRole('button', { name: 'Select users…' }));
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'request',
    body: { kind: 'choose-authors' },
  });
  await user.click(screen.getByRole('button', { name: 'Date filter' }));
  await user.click(screen.getByRole('button', { name: 'Last 24 hours' }));
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'filters',
    filters: {
      regex: false,
      matchCase: false,
      author: { kind: 'all' },
      date: '24h',
    },
  });
});

test('calendar date drafts cancel, reject reversed bounds and apply one inclusive range', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();

  render(<LogPage data={initialView()} onIntent={onIntent} />);
  const date = screen.getByRole('button', { name: 'Date filter' });

  await user.click(date);
  await user.click(screen.getByRole('button', { name: 'Select period…' }));
  const from = screen.getByLabelText('From');

  expect(from).toHaveFocus();

  fireEvent.change(from, { target: { value: '2026-10-06' } });
  await user.keyboard('{Escape}');
  expect(onIntent).not.toHaveBeenCalled();
  expect(date).toHaveFocus();
  await user.click(date);
  await user.click(screen.getByRole('button', { name: 'Select period…' }));
  expect(screen.getByLabelText('From')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('From'), {
    target: { value: '2026-10-06' },
  });
  fireEvent.change(screen.getByLabelText('To'), {
    target: { value: '2026-10-05' },
  });
  await user.click(screen.getByRole('button', { name: 'Apply dates' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(onIntent).toHaveBeenCalledExactlyOnceWith({
    kind: 'request',
    body: { kind: 'invalid-date-filter' },
  });
  fireEvent.change(screen.getByLabelText('To'), {
    target: { value: '2026-10-06' },
  });
  await user.click(screen.getByRole('button', { name: 'Apply dates' }));
  expect(onIntent).toHaveBeenCalledTimes(2);
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'filters',
    filters: {
      ...initialView().filters,
      date: { kind: 'range', from: '2026-10-06', to: '2026-10-06' },
    },
  });
  expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
});

test('view options expose revision visibility and return keyboard focus', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();

  render(<LogPage data={initialView()} onIntent={onIntent} />);
  await user.click(screen.getByRole('button', { name: 'View options' }));
  await user.click(screen.getByRole('button', { name: 'Columns' }));
  await user.click(screen.getByRole('checkbox', { name: 'Hash' }));
  expect(onIntent).toHaveBeenLastCalledWith({ kind: 'show-hash', show: true });
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'View options' })).toHaveFocus();
});

test('view options group columns and highlights without changing history filters', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();

  render(<LogPage data={initialView()} onIntent={onIntent} />);
  await user.click(screen.getByRole('button', { name: 'View options' }));
  expect(screen.getByText('Show', { exact: true })).toBeInTheDocument();
  expect(
    screen.queryByRole('checkbox', { name: 'Author' }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Columns' }));
  expect(
    await screen.findByRole('group', { name: 'Columns' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Author' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Date' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Hash' })).not.toBeChecked();
  for (const name of ['My Commits', 'Merge Commits', 'Current Branch'])
    expect(screen.getByRole('checkbox', { name })).toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'Author' }));
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'presentation',
    presentation: { ...initialView().presentation, showAuthor: false },
  });
  await user.click(screen.getByRole('checkbox', { name: 'Current Branch' }));
  expect(onIntent).toHaveBeenLastCalledWith({
    kind: 'presentation',
    presentation: {
      ...initialView().presentation,
      highlightCurrentBranch: false,
    },
  });
});

test('date starts with presets and opens an explicit period draft without applying it', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();

  render(<LogPage data={initialView()} onIntent={onIntent} />);
  const date = screen.getByRole('button', { name: 'Date filter' });

  expect(date).toHaveTextContent(/^Date$/);
  await user.click(date);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Select period…' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Last 24 hours' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Select period…' }));
  expect(screen.getByLabelText('From')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onIntent).not.toHaveBeenCalled();
  expect(date).toHaveFocus();
});

test('clearing an active date returns focus to its remaining trigger and preserves scope', async () => {
  const user = userEvent.setup();
  const onIntent = vi.fn();
  const data = initialView();

  render(
    <LogPage
      data={{
        ...data,
        scope: { kind: 'all' },
        filters: { ...data.filters, date: '7d' },
      }}
      onIntent={onIntent}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Clear date filter' }));
  expect(onIntent).toHaveBeenCalledExactlyOnceWith({
    kind: 'filters',
    filters: { ...data.filters, date: 'all' },
  });
  expect(screen.getByRole('button', { name: 'Date filter' })).toHaveFocus();
});
