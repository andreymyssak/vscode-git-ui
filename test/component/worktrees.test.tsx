import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { WorktreesPage } from '../../src/webview/pages/worktrees';

test('unavailable worktree cannot open; updates preserve selection and focus', async () => {
  const user = userEvent.setup();
  const request = vi.fn();
  const item = {
    id: 'owned-worktree',
    name: 'Fixture',
    branch: null,
    current: false,
    available: false,
    rootUri: 'file:///example%20repo',
  };
  const { rerender } = render(
    <WorktreesPage worktrees={[item]} onRequest={request} />,
  );
  const row = screen.getByRole('row', {
    name: /Fixture.*Detached HEAD.*unavailable/,
  });

  await user.click(row);
  await user.keyboard('{Enter}');
  expect(request).not.toHaveBeenCalled();
  rerender(
    <WorktreesPage
      worktrees={[{ ...item, available: true }]}
      onRequest={request}
    />,
  );
  expect(row).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(request).toHaveBeenCalledExactlyOnceWith({
    kind: 'open-worktree',
    worktreeId: item.id,
    newWindow: true,
  });
});

test('worktrees expose named columns and creation independent of row selection', async () => {
  const user = userEvent.setup();
  const request = vi.fn();
  const item = {
    id: 'linked',
    name: 'Linked workspace',
    branch: 'feature/topic',
    main: false,
    current: false,
    available: true,
    rootUri: 'file:///example%20repo/linked',
  };
  const { rerender } = render(
    <WorktreesPage worktrees={[item]} onRequest={request} />,
  );
  const toolbar = screen.getByRole('toolbar', { name: 'Worktree actions' });

  expect(
    within(toolbar)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label')),
  ).toEqual(['Refresh Worktrees', 'Create Worktree']);
  const create = within(toolbar).getByRole('button', {
    name: 'Create Worktree',
  });

  await user.click(create);
  expect(request).toHaveBeenLastCalledWith({
    kind: 'action',
    action: { kind: 'create-worktree' },
  });
  for (const name of ['Worktree', 'Branch', 'Path'])
    expect(screen.getByRole('columnheader', { name })).toBeVisible();
  const row = screen.getByRole('row', {
    name: /Linked workspace.*feature\/topic/,
  });

  expect(
    within(row)
      .getAllByRole('gridcell')
      .map((cell) => cell.textContent),
  ).toEqual(['Linked workspace', 'feature/topic', '/example repo/linked']);
  await user.click(row);
  await user.keyboard('{Delete}');
  expect(request).toHaveBeenLastCalledWith({
    kind: 'action',
    action: { kind: 'delete-worktrees', worktreeIds: [item.id] },
  });
  await user.click(
    within(toolbar).getByRole('button', { name: 'Refresh Worktrees' }),
  );
  expect(request).toHaveBeenLastCalledWith({ kind: 'worktrees', retry: true });
  rerender(<WorktreesPage worktrees={[]} onRequest={request} />);
  await user.click(create);
  expect(request).toHaveBeenLastCalledWith({
    kind: 'action',
    action: { kind: 'create-worktree' },
  });
  rerender(<WorktreesPage worktrees={[item]} onRequest={request} />);
  expect(screen.getByRole('row', { name: /Linked workspace/ })).toHaveAttribute(
    'aria-selected',
    'false',
  );
});

for (const [rootUri, path] of [
  ['file:///C:/repo%20name/worktree', 'C:/repo name/worktree'],
  ['file://server/share/repo%20name', '//server/share/repo name'],
] as const)
  test(`worktree path preserves the local drive or network root, ${rootUri}`, () => {
    render(
      <WorktreesPage
        worktrees={[
          {
            id: rootUri,
            name: 'Workspace',
            branch: 'main',
            current: true,
            available: true,
            rootUri,
          },
        ]}
        onRequest={vi.fn()}
      />,
    );
    expect(screen.getByRole('gridcell', { name: path })).toBeVisible();
  });

test('keyboard users can create without a selected row and select with Space', async () => {
  const user = userEvent.setup();
  const request = vi.fn();
  const item = {
    id: 'sole',
    name: 'Sole workspace',
    branch: 'main',
    main: false,
    current: false,
    available: true,
    rootUri: 'file:///example',
  };

  render(<WorktreesPage worktrees={[item]} onRequest={request} />);
  await user.tab();
  expect(
    screen.getByRole('button', { name: 'Refresh Worktrees' }),
  ).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Create Worktree' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(request).toHaveBeenCalledExactlyOnceWith({
    kind: 'action',
    action: { kind: 'create-worktree' },
  });
  request.mockClear();
  await user.tab();
  const row = screen.getByRole('row', { name: /Sole workspace/ });

  expect(row).toHaveFocus();
  await user.keyboard(' ');
  expect(row).toHaveAttribute('aria-selected', 'true');
  expect(request).not.toHaveBeenCalled();
});

test('Shift selects a range for deletion, context keeps that group, and current worktree cannot open', async () => {
  const user = userEvent.setup();
  const request = vi.fn();
  const worktrees = ['main', 'alpha', 'beta'].map((id) => ({
    id,
    name: id,
    branch: id,
    rootUri: 'file:///example/' + id,
    current: id === 'main',
    main: id === 'main',
    locked: false,
    available: true,
  }));

  render(<WorktreesPage worktrees={worktrees} onRequest={request} />);
  const current = screen.getByRole('row', { name: /main.*current/ });

  await user.click(current);
  expect(
    JSON.parse(current.getAttribute('data-vscode-context')!).worktreeCanOpen,
  ).toBe(false);
  await user.keyboard('{Enter}');
  expect(request).not.toHaveBeenCalled();
  const alpha = screen.getByRole('row', { name: /^alpha/ });
  const beta = screen.getByRole('row', { name: /^beta/ });

  await user.click(alpha);
  await user.keyboard('{Shift>}');
  await user.click(beta);
  await user.keyboard('{/Shift}');
  expect(alpha).toHaveAttribute('aria-selected', 'true');
  expect(beta).toHaveAttribute('aria-selected', 'true');
  expect(
    JSON.parse(beta.getAttribute('data-vscode-context')!).worktreeIds,
  ).toEqual(['alpha', 'beta']);
  await user.keyboard('{Delete}');
  expect(request).toHaveBeenLastCalledWith({
    kind: 'action',
    action: { kind: 'delete-worktrees', worktreeIds: ['alpha', 'beta'] },
  });
});
