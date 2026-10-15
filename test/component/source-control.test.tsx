import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type {
  SourceControlBridge,
  SourceControlRequest,
  SourceControlResponse,
  SourceControlState,
  StashEntry,
} from '../../src/shared/source-control';
import { SourceControlPage } from '../../src/webview/pages/source-control';

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

const repository = {
  pathLabel: { root: '/workspace', separator: '/' as const },
  info: {
    id: 'root',
    label: 'Workspace',
    rootUri: 'file:///workspace',
    headSha: 'a'.repeat(40),
    branch: 'main',
  },
  changes: {
    kind: 'ready' as const,
    items: [
      {
        path: 'src/nested/a.ts',
        originalPath: 'src/nested/a.ts',
        status: 'MM',
        staged: true,
        working: true,
        untracked: false,
      },
      {
        path: 'src/b.ts',
        originalPath: 'src/b.ts',
        status: ' M',
        staged: false,
        working: true,
        untracked: false,
      },
      {
        path: 'staged.txt',
        originalPath: 'staged.txt',
        status: 'A ',
        staged: true,
        working: false,
        untracked: false,
      },
    ],
  },
  stashes: { kind: 'ready' as const, items: [] },
  checked: ['src/b.ts'],
  draft: '',
  draftEditId: null,
  operation: { kind: 'ready' as const, items: [] },
  commitMode: { kind: 'new' as const },
};

function workingTree() {
  return within(screen.getByRole('tree', { name: 'Changes' }));
}

function initialState(): SourceControlState {
  return {
    hoverDelay: 500,
    repositories: [{ ...repository }],
    repositoryId: 'root',
    tab: 'commit',
    busy: false,
    generating: false,
    reveal: null,
  };
}

function session(
  state = initialState(),
  saved: unknown = null,
  acknowledge = true,
) {
  let current = state;
  let persisted = saved;
  const requests: SourceControlRequest[] = [];
  const listeners = new Set<(response: SourceControlResponse) => void>();
  const emit = (value: SourceControlState) => {
    current = value;
    act(() => {
      for (const listener of listeners)
        listener({ kind: 'source-control-state', state: current });
    });
  };

  const bridge: SourceControlBridge = {
    send(request) {
      requests.push(request);
      if (!acknowledge) return;
      if (request.kind === 'tab') emit({ ...current, tab: request.tab });
      if (request.kind === 'repository')
        emit({ ...current, repositoryId: request.repositoryId });
      if (request.kind === 'message' || request.kind === 'check')
        emit({
          ...current,
          repositories: current.repositories.map((repo) => {
            if (repo.info.id !== request.repositoryId) return repo;
            if (request.kind === 'message')
              return {
                ...repo,
                draft: request.message,
                draftEditId: request.editId,
              };
            const checked = new Set(repo.checked);

            for (const path of request.paths)
              if (request.checked) checked.add(path);
              else checked.delete(path);

            return { ...repo, checked: [...checked] };
          }),
        });
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    getState: () => persisted,
    setState: (value) => {
      persisted = value;
    },
    dispose() {},
  };

  render(<SourceControlPage bridge={bridge} />);
  emit(state);

  return {
    requests,
    emit,
    state: () => current,
    saved: () => persisted,
    listeners,
  };
}

test('separates merge, index and working changes while linking whole-file checkboxes', async () => {
  const user = userEvent.setup();
  const state = initialState();
  const repo = state.repositories[0]!;

  repo.draft = 'Checked files';
  repo.changes = {
    kind: 'ready',
    items: [
      ...repository.changes.items,
      {
        path: 'conflict.txt',
        originalPath: 'conflict.txt',
        status: 'UU',
        staged: true,
        working: true,
        untracked: false,
      },
    ],
  };
  const app = session(state);
  const merge = within(screen.getByRole('tree', { name: 'Merge Changes' }));
  const staged = within(screen.getByRole('tree', { name: 'Staged Changes' }));
  const working = within(screen.getByRole('tree', { name: 'Changes' }));

  expect(merge.getByRole('treeitem', { name: 'conflict.txt' })).toBeVisible();
  expect(staged.queryByRole('treeitem', { name: 'conflict.txt' })).toBeNull();
  expect(working.queryByRole('treeitem', { name: 'conflict.txt' })).toBeNull();
  expect(staged.getByRole('treeitem', { name: 'staged.txt' })).toBeVisible();
  expect(working.queryByRole('treeitem', { name: 'staged.txt' })).toBeNull();
  await user.click(
    staged.getByRole('checkbox', { name: 'Include src/nested/a.ts' }),
  );
  expect(
    working.getByRole('checkbox', { name: 'Include src/nested/a.ts' }),
  ).toBeChecked();
  expect(app.requests.at(-1)).toEqual({
    kind: 'check',
    repositoryId: 'root',
    paths: ['src/nested/a.ts'],
    checked: true,
  });
  expect(
    screen.getByRole('status', { name: 'Checked files summary' }),
  ).toHaveTextContent('M 2');
  await user.click(screen.getByRole('button', { name: 'Commit' }));
  expect(app.requests.at(-1)).toEqual({ kind: 'commit', repositoryId: 'root' });
  await user.click(staged.getByRole('treeitem', { name: 'src/nested/a.ts' }));
  expect(app.requests.at(-1)).toEqual({
    kind: 'open-working',
    repositoryId: 'root',
    path: 'src/nested/a.ts',
    index: true,
  });
  await user.click(working.getByRole('treeitem', { name: 'src/nested/a.ts' }));
  expect(app.requests.at(-1)).toEqual({
    kind: 'open-working',
    repositoryId: 'root',
    path: 'src/nested/a.ts',
    index: false,
  });
});

test('Stage and Unstage actions use their section without changing commit inclusion', async () => {
  const user = userEvent.setup();
  const app = session();
  const staged = within(screen.getByRole('tree', { name: 'Staged Changes' }));
  const working = within(screen.getByRole('tree', { name: 'Changes' }));
  const workingRow = working.getByRole('treeitem', { name: 'src/nested/a.ts' });
  const stagedRow = staged.getByRole('treeitem', { name: 'src/nested/a.ts' });

  await user.click(
    within(workingRow).getByRole('button', { name: 'Stage Changes' }),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'stage-files',
    repositoryId: 'root',
    paths: ['src/nested/a.ts'],
  });
  await user.click(
    within(stagedRow).getByRole('button', { name: 'Unstage Changes' }),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'unstage-files',
    repositoryId: 'root',
    paths: ['src/nested/a.ts'],
  });
  expect(app.state().repositories[0]!.checked).toEqual(['src/b.ts']);
  expect(
    JSON.parse(workingRow.getAttribute('data-vscode-context')!),
  ).toMatchObject({
    changeCanStage: true,
    changeCanUnstage: false,
  });
  expect(
    JSON.parse(stagedRow.getAttribute('data-vscode-context')!),
  ).toMatchObject({
    changeCanStage: false,
    changeCanUnstage: true,
  });
});

test('commit statistics count checked files once by status and update with folder inclusion and refresh', async () => {
  const user = userEvent.setup();
  const state = initialState();
  const repo = state.repositories[0]!;

  repo.changes = {
    kind: 'ready',
    items: ['A ', 'MM', ' M', ' D', 'R ', '??', 'UU', ' X'].map(
      (status, index) => ({
        path: `src/file-${index}.ts`,
        originalPath: `src/file-${index}.ts`,
        status,
        staged: status[0] !== ' ' && status !== '??',
        working: status[1] !== ' ',
        untracked: status === '??',
      }),
    ),
  };
  repo.checked = [
    ...repo.changes.items.map((file) => file.path),
    'src/file-1.ts',
    'gone.ts',
  ];
  const app = session(state);
  const summary = screen.getByRole('status', { name: 'Checked files summary' });

  for (const text of ['A 1', 'M 2', 'D 1', 'R 1', 'U 1', '! 1', '? 1'])
    expect(
      within(summary).getByText(text, { exact: true }),
    ).toBeInTheDocument();
  await user.click(
    workingTree().getByRole('checkbox', { name: 'Include src' }),
  );
  for (const text of ['A 1', 'R 1', '! 1'])
    expect(
      within(summary).getByText(text, { exact: true }),
    ).toBeInTheDocument();
  expect(within(summary).queryByText('M 2', { exact: true })).toBeNull();
  const indexFolder = within(
    screen.getByRole('tree', { name: 'Staged Changes' }),
  ).getByRole('checkbox', { name: 'Include src' });

  // A partially included folder first includes its files; the next click clears it.
  await user.click(indexFolder);
  await user.click(indexFolder);
  await user.click(
    within(screen.getByRole('tree', { name: 'Merge Changes' })).getByRole(
      'checkbox',
      { name: 'Include src' },
    ),
  );
  expect(
    screen.queryByRole('status', { name: 'Checked files summary' }),
  ).toBeNull();
  await user.click(
    within(workingTree().getByRole('treeitem', { name: 'src' })).getByRole(
      'checkbox',
      { name: 'Include src' },
    ),
  );
  expect(
    screen.getByRole('status', { name: 'Checked files summary' }),
  ).toHaveTextContent('M 2');
  app.emit({
    ...app.state(),
    repositories: [
      {
        ...app.state().repositories[0]!,
        changes: { kind: 'ready', items: [] },
      },
    ],
  });
  expect(
    screen.queryByRole('status', { name: 'Checked files summary' }),
  ).toBeNull();
});

test.each([
  { statuses: ['??', ' M'], kind: 'modified' },
  { statuses: [' M', '??'], kind: 'modified' },
  { statuses: ['M ', '??'], kind: 'modified', section: 'Staged Changes' },
  { statuses: [' M', 'UU'], kind: 'conflict', section: 'Merge Changes' },
  { statuses: ['DD', '??'], kind: 'conflict', section: 'Merge Changes' },
  { statuses: [' D', '??'], kind: 'untracked' },
  { statuses: ['D ', 'A '], kind: 'added', section: 'Staged Changes' },
  { statuses: ['R '], kind: 'renamed', section: 'Staged Changes' },
  { statuses: [' D', 'D '], kind: undefined },
])(
  'folder status reflects descendants in its section: $statuses',
  ({ statuses, kind, section = 'Changes' }) => {
    const state = initialState();

    state.repositories[0]!.changes = {
      kind: 'ready',
      items: statuses.map((status, index) => ({
        path: `src/file-${index}.ts`,
        originalPath: `src/file-${index}.ts`,
        status,
        staged: status[0] !== ' ' && status !== '??',
        working: status[1] !== ' ',
        untracked: status === '??',
      })),
    };
    session(state);
    const folder = within(
      screen.getByRole('tree', { name: section }),
    ).getByRole('treeitem', { name: 'src' });
    const dot = folder.querySelector('[data-folder-status]');

    if (kind) {
      expect(folder).toHaveAttribute('data-status', kind);
      expect(folder).toHaveAccessibleDescription('Contains emphasized items');
      expect(dot).toBeInTheDocument();
    } else {
      expect(dot).toBeNull();
      expect(folder).not.toHaveAccessibleDescription();
    }
  },
);

test('Discard targets one working file without opening it or changing checked files', async () => {
  const user = userEvent.setup();
  const app = session();
  const row = workingTree().getByRole('treeitem', { name: 'src/nested/a.ts' });

  await user.click(
    within(row).getByRole('button', { name: 'Discard Changes' }),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'discard-working',
    repositoryId: 'root',
    path: 'src/nested/a.ts',
  });
  expect(app.state().repositories[0]?.checked).toEqual(['src/b.ts']);
  expect(app.requests.some((request) => request.kind === 'open-working')).toBe(
    false,
  );
  expect(
    within(screen.getByRole('treeitem', { name: 'staged.txt' })).queryByRole(
      'button',
      { name: 'Discard Changes' },
    ),
  ).toBeNull();
  app.emit({ ...app.state(), busy: true });
  expect(
    within(row).getByRole('button', { name: 'Discard Changes' }),
  ).toBeDisabled();
});

test('conflicted files have no Discard action', () => {
  const original = repository.changes.items[0]!;

  session({
    ...initialState(),
    repositories: [
      {
        ...repository,
        changes: { kind: 'ready', items: [{ ...original, status: 'UU' }] },
      },
    ],
  });
  const row = screen.getByRole('treeitem', { name: original.path });

  expect(row).toHaveAccessibleDescription('Conflict: Both Modified');
  expect(
    within(row).queryByRole('button', { name: 'Discard Changes' }),
  ).toBeNull();
});

test('the Changes root toggles its files and the toolbar expands, collapses and groups the tree', async () => {
  const user = userEvent.setup();
  const app = session();
  const root = screen.getByRole('treeitem', { name: 'Changes' });

  expect(root).toHaveAttribute('aria-level', '1');
  expect(root).toHaveAttribute('aria-checked', 'mixed');
  await user.click(root);
  expect(app.requests.at(-1)).toEqual({
    kind: 'check',
    repositoryId: 'root',
    paths: repository.changes.items
      .filter((file) => file.working)
      .map((file) => file.path),
    checked: true,
  });
  await user.click(screen.getByRole('button', { name: 'Collapse All' }));
  expect(screen.queryByRole('treeitem', { name: 'src/b.ts' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Expand All' }));
  expect(
    workingTree().getByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'View Options' }));
  await user.click(
    screen.getByRole('checkbox', { name: 'Group by Directory' }),
  );
  expect(workingTree().queryByRole('treeitem', { name: 'src' })).toBeNull();
  expect(
    workingTree().getByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toHaveAttribute('aria-level', '2');
  expect(app.saved()).toMatchObject({ groupByDirectory: false });
});

test('the Changes tree disappears when the working copy becomes clean', () => {
  const app = session();

  expect(screen.getByRole('tree', { name: 'Changes' })).toBeVisible();
  app.emit({
    ...initialState(),
    repositories: [
      { ...repository, changes: { kind: 'ready', items: [] }, checked: [] },
    ],
  });
  expect(screen.getByText('No changes.')).toBeVisible();
  expect(screen.queryByRole('tree', { name: 'Changes' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Commit message' })).toBeVisible();

  app.emit(initialState());
  expect(screen.queryByText('No changes.')).toBeNull();
  expect(screen.getByRole('tree', { name: 'Changes' })).toBeVisible();
});

test('commit message tools group Amend and generation above the editor', async () => {
  const user = userEvent.setup();
  const app = session();
  const toolbar = screen.getByRole('toolbar', {
    name: 'Commit message actions',
  });

  expect(
    within(toolbar).getByRole('checkbox', { name: 'Amend last commit' }),
  ).not.toBeChecked();
  expect(
    within(toolbar).getByRole('button', { name: 'Generate Commit Message' }),
  ).toBeEnabled();
  await user.click(
    within(toolbar).getByRole('checkbox', { name: 'Amend last commit' }),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'amend',
    repositoryId: 'root',
    enabled: true,
  });
});

test('the commit message section remembers keyboard resizing without changing the draft', async () => {
  const user = userEvent.setup();
  const app = session(
    {
      ...initialState(),
      repositories: [{ ...repository, draft: 'Keep this draft' }],
    },
    { messageHeight: 210 },
  );
  const divider = screen.getByRole('separator', {
    name: 'Resize commit message',
  });

  expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  expect(divider).toHaveAttribute('aria-valuenow', '210');
  divider.focus();
  await user.keyboard('{ArrowUp}');
  expect(divider).toHaveAttribute('aria-valuenow', '220');
  expect(app.saved()).toMatchObject({ messageHeight: 220 });
  await user.keyboard('{ArrowDown}');
  expect(divider).toHaveAttribute('aria-valuenow', '210');
  expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Keep this draft',
  );
  expect(app.requests).toEqual([
    { kind: 'ready', repositoryId: null, tab: 'commit' },
  ]);
});

test.each(['loading', 'error'] as const)(
  'Amend stays disabled while Changes is %s so hidden checks cannot be committed',
  (kind) => {
    session({
      ...initialState(),
      repositories: [
        {
          ...repository,
          draft: 'Amended message',
          commitMode: { kind: 'amend', headSha: repository.info.headSha! },
          changes:
            kind === 'loading' ? { kind } : { kind, message: 'Unavailable' },
        },
      ],
    });
    expect(screen.getByRole('button', { name: 'Amend Commit' })).toBeDisabled();
  },
);

test('an active Amend can be turned off after HEAD becomes unavailable', async () => {
  const user = userEvent.setup();
  const app = session({
    ...initialState(),
    repositories: [
      {
        ...repository,
        info: { ...repository.info, headSha: null },
        commitMode: { kind: 'amend', headSha: repository.info.headSha! },
      },
    ],
  });
  const amend = screen.getByRole('checkbox', { name: 'Amend last commit' });

  expect(amend).toBeEnabled();
  await user.click(amend);
  expect(app.requests.at(-1)).toEqual({
    kind: 'amend',
    repositoryId: 'root',
    enabled: false,
  });
});

test('a saved flat list can enable directory grouping without changing checked files', async () => {
  const user = userEvent.setup();
  const app = session(initialState(), { groupByDirectory: false });

  expect(
    workingTree().getByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toHaveAttribute('aria-level', '2');
  await user.click(screen.getByRole('button', { name: 'View Options' }));
  const grouping = screen.getByRole('checkbox', { name: 'Group by Directory' });

  expect(grouping).toBeEnabled();
  expect(grouping).not.toBeChecked();
  await user.click(grouping);
  expect(grouping).toBeChecked();
  expect(
    workingTree().getByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toHaveAttribute('aria-level', '4');
  expect(app.saved()).toMatchObject({ groupByDirectory: true });
  expect(app.state().repositories[0]?.checked).toEqual(['src/b.ts']);
  expect(app.requests).toHaveLength(1);
});

test('select opened file expands and focuses its row without changing checked files or opening a diff', async () => {
  const user = userEvent.setup();
  const app = session(initialState(), {
    collapsed: [
      JSON.stringify(['root', 'working', '']),
      JSON.stringify(['root', 'working', 'src']),
    ],
  });

  await user.click(screen.getByRole('button', { name: 'View Options' }));
  await user.click(
    screen.getByRole('button', { name: 'Select Opened File in Changes View' }),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'reveal-working',
    repositoryId: 'root',
  });
  const count = app.requests.length;

  app.emit({
    ...app.state(),
    reveal: { repositoryId: 'root', path: 'src/nested/a.ts', sequence: 1 },
  });
  const file = workingTree().getByRole('treeitem', { name: 'src/nested/a.ts' });

  expect(file).toHaveFocus();
  expect(file).toHaveAttribute('aria-selected', 'true');
  expect(app.state().repositories[0]?.checked).toEqual(['src/b.ts']);
  expect(app.requests).toHaveLength(count);
  await user.click(screen.getByRole('button', { name: 'Collapse All' }));
  app.emit({
    ...app.state(),
    reveal: { repositoryId: 'root', path: 'src/nested/a.ts', sequence: 1 },
  });
  expect(
    workingTree().queryByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toBeNull();
  app.emit({
    ...app.state(),
    reveal: { repositoryId: 'root', path: 'src/nested/a.ts', sequence: 2 },
  });
  expect(
    workingTree().getByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toHaveFocus();
});

test.each([
  { section: 'index', label: 'Staged Changes', status: 'M ', working: false },
  { section: 'merge', label: 'Merge Changes', status: 'UU', working: true },
])(
  'reveal expands a collapsed $label without changing inclusion',
  ({ section, label, status, working }) => {
    const file = { ...repository.changes.items[0]!, status, working };
    const app = session(
      {
        ...initialState(),
        repositories: [
          { ...repository, changes: { kind: 'ready', items: [file] } },
        ],
      },
      {
        collapsed: ['', 'src', 'src/nested'].map((path) =>
          JSON.stringify(['root', section, path]),
        ),
      },
    );
    const tree = within(screen.getByRole('tree', { name: label }));

    expect(tree.queryByRole('treeitem', { name: file.path })).toBeNull();
    app.emit({
      ...app.state(),
      reveal: { repositoryId: 'root', path: file.path, sequence: 1 },
    });
    expect(tree.getByRole('treeitem', { name: file.path })).toHaveFocus();
    expect(app.state().repositories[0]!.checked).toEqual(['src/b.ts']);
  },
);

test('Stash Silently uses checked files without requiring a commit message', async () => {
  const user = userEvent.setup();
  const app = session();
  const stash = screen.getByRole('button', { name: 'Stash Silently' });

  expect(stash).toBeEnabled();
  await user.click(stash);
  expect(app.requests.at(-1)).toEqual({
    kind: 'stash-silently',
    repositoryId: 'root',
  });
});

test('restores the selected repository and tab and keeps view memory on updates', async () => {
  const user = userEvent.setup();
  const saved = { repositoryId: 'root', tab: 'stash', collapsed: [] };
  const app = session({ ...initialState(), tab: 'stash' }, saved);

  expect(app.requests[0]).toEqual({
    kind: 'ready',
    repositoryId: 'root',
    tab: 'stash',
  });
  expect(screen.getByRole('tab', { name: 'Stashes' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await user.click(screen.getByRole('tab', { name: 'Commit' }));
  expect(app.requests.at(-1)).toEqual({ kind: 'tab', tab: 'commit' });
  expect(app.saved()).toMatchObject({ ...saved, tab: 'commit' });
});

test('expanded folders check descendants independently of Git staging and file rows open native diffs', async () => {
  const user = userEvent.setup();
  const app = session();
  const tree = screen.getByRole('tree', { name: 'Changes' });
  const source = within(tree).getByRole('treeitem', { name: 'src' });

  expect(source).toHaveAttribute('aria-expanded', 'true');
  expect(
    within(tree).getByRole('treeitem', { name: 'src/nested' }),
  ).toHaveAttribute('aria-expanded', 'true');
  expect(
    workingTree().getByRole('checkbox', { name: 'Include src/nested/a.ts' }),
  ).not.toBeChecked();
  expect(
    workingTree().getByRole('checkbox', { name: 'Include src/b.ts' }),
  ).toBeChecked();
  expect(
    workingTree().getByRole('checkbox', { name: 'Include src' }),
  ).toBePartiallyChecked();
  await user.click(
    workingTree().getByRole('checkbox', { name: 'Include src' }),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'check',
    repositoryId: 'root',
    paths: ['src/nested/a.ts', 'src/b.ts'],
    checked: true,
  });
  const file = within(tree).getByRole('treeitem', { name: 'src/nested/a.ts' });

  await user.hover(within(file).getByText('a.ts'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent(
    'src/nested/a.ts',
  );
  expect(screen.getByRole('tooltip')).toHaveTextContent('Modified');
  await user.unhover(within(file).getByText('a.ts'));
  expect(file).toHaveTextContent('a.ts');
  expect(file).not.toHaveTextContent('src/nested/a.ts');
  await user.click(file);
  expect(app.requests.at(-1)).toEqual({
    kind: 'open-working',
    repositoryId: 'root',
    path: 'src/nested/a.ts',
    index: false,
  });
  await user.click(
    within(screen.getByRole('tree', { name: 'Staged Changes' })).getByRole(
      'treeitem',
      { name: 'staged.txt' },
    ),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'open-working',
    repositoryId: 'root',
    path: 'staged.txt',
    index: true,
  });
  expect(
    JSON.parse(file.getAttribute('data-vscode-context') ?? '{}'),
  ).toMatchObject({
    webviewSection: 'working-change',
    repositoryId: 'root',
    path: 'src/nested/a.ts',
    staged: false,
    changeCanStage: true,
  });
});

test('inline message gates committing while checked files enable silent stashing and generation', async () => {
  const user = userEvent.setup();
  const app = session();
  const message = screen.getByRole('textbox', { name: 'Commit message' });
  const commit = screen.getByRole('button', { name: 'Commit' });
  const stash = screen.getByRole('button', { name: 'Stash Silently' });
  const generate = screen.getByRole('button', {
    name: 'Generate Commit Message',
  });

  expect(commit).toBeDisabled();
  expect(stash).toBeEnabled();
  expect(generate).toBeEnabled();
  await user.type(message, 'Fix sidebar');
  expect(app.requests.at(-1)).toEqual({
    kind: 'message',
    repositoryId: 'root',
    message: 'Fix sidebar',
    editId: expect.any(String),
  });
  await user.click(commit);
  expect(app.requests.at(-1)).toEqual({ kind: 'commit', repositoryId: 'root' });
  await user.click(stash);
  expect(app.requests.at(-1)).toEqual({
    kind: 'stash-silently',
    repositoryId: 'root',
  });
  await user.click(generate);
  expect(app.requests.at(-1)).toEqual({
    kind: 'generate',
    repositoryId: 'root',
  });
  const count = app.requests.filter(
    (request) => request.kind === 'commit',
  ).length;

  app.emit({ ...app.state(), generating: true });
  expect(commit).toBeDisabled();
  expect(message).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Cancel Generation' }));
  expect(app.requests.at(-1)).toEqual({ kind: 'cancel-generation' });
  app.emit({
    ...app.state(),
    generating: false,
    repositories: [{ ...repository, draft: 'Generated draft' }],
  });
  expect(message).toHaveValue('Generated draft');
  expect(
    app.requests.filter((request) => request.kind === 'commit'),
  ).toHaveLength(count);
  app.emit({ ...app.state(), busy: true });
  expect(commit).toBeDisabled();
  expect(stash).toBeDisabled();
  expect(generate).toBeDisabled();
  expect(message).toBeDisabled();
  app.emit({
    ...initialState(),
    repositories: [{ ...repository, checked: [], draft: 'Draft' }],
  });
  expect(commit).toBeDisabled();
  expect(stash).toBeDisabled();
  expect(generate).toBeDisabled();
});

test('multiple repositories require an explicit target and preserve repository drafts', async () => {
  const user = userEvent.setup();
  const app = session({
    ...initialState(),
    repositoryId: null,
    repositories: [
      { ...repository, draft: 'First draft' },
      {
        ...repository,
        info: { ...repository.info, id: 'other', label: 'Other' },
        draft: 'Other draft',
      },
    ],
  });

  expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    '',
  );
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Repository' }),
    'other',
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'repository',
    repositoryId: 'other',
  });
  expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Other draft',
  );
  await user.click(screen.getByRole('button', { name: 'Commit' }));
  expect(app.requests.at(-1)).toEqual({
    kind: 'commit',
    repositoryId: 'other',
  });
});

test('stash files load on expansion, group snapshots and restore only checked identities', async () => {
  const user = userEvent.setup();
  const stash: StashEntry = {
    sha: 'b'.repeat(40),
    viewId: 'b'.repeat(40),
    selector: 'stash@{0}',
    message: 'Saved work',
    date: '2026-10-10T10:00:00Z',
    base: 'a'.repeat(40),
    files: null,
  };
  const app = session({
    ...initialState(),
    tab: 'stash',
    repositories: [
      { ...repository, stashes: { kind: 'ready', items: [stash] } },
    ],
  });

  expect(app.requests.some((request) => request.kind === 'load-stash')).toBe(
    false,
  );
  await user.click(screen.getByRole('button', { name: 'Expand Saved work' }));
  expect(app.requests.at(-1)).toEqual({
    kind: 'load-stash',
    repositoryId: 'root',
    sha: stash.sha,
  });
  const files = [
    {
      path: 'src/a.ts',
      originalPath: 'src/a.ts',
      status: 'M',
      snapshot: 'working' as const,
      oldRef: stash.base,
      newRef: stash.sha,
      deleted: false,
    },
    {
      path: 'src/a.ts',
      originalPath: 'src/a.ts',
      status: 'M',
      snapshot: 'index' as const,
      oldRef: stash.base,
      newRef: stash.sha,
      deleted: false,
    },
    {
      path: 'new.txt',
      originalPath: 'new.txt',
      status: 'A',
      snapshot: 'untracked' as const,
      oldRef: null,
      newRef: stash.sha,
      deleted: false,
    },
  ];

  app.emit({
    ...app.state(),
    repositories: [
      {
        ...repository,
        stashes: {
          kind: 'ready',
          items: [{ ...stash, files: { kind: 'ready', items: files } }],
        },
      },
    ],
  });
  const working = screen.getByRole('tree', { name: 'Working files' });
  const index = screen.getByRole('tree', { name: 'Staged files' });

  expect(screen.getByRole('tree', { name: 'Untracked files' })).toBeVisible();
  await user.click(
    within(index).getByRole('checkbox', { name: 'Include src/a.ts' }),
  );
  await user.click(screen.getByRole('button', { name: 'Apply Stash' }));
  expect(app.requests.at(-1)).toEqual({
    kind: 'restore-stash-files',
    repositoryId: 'root',
    sha: stash.sha,
    files: [{ path: 'src/a.ts', snapshot: 'index' }],
  });
  await user.click(within(working).getByRole('treeitem', { name: 'src/a.ts' }));
  expect(app.requests.at(-1)).toEqual({
    kind: 'open-stash-file',
    repositoryId: 'root',
    sha: stash.sha,
    file: { path: 'src/a.ts', snapshot: 'working' },
  });
  await user.click(
    within(index).getByRole('checkbox', { name: 'Include src/a.ts' }),
  );
  expect(screen.getByRole('button', { name: 'Apply Stash' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Collapse Saved work' }));
  await user.click(screen.getByRole('button', { name: 'Apply Stash' }));
  expect(app.requests.at(-1)).toEqual({
    kind: 'restore-stash',
    repositoryId: 'root',
    sha: stash.sha,
  });
});

test('Stash toolbar expands all stashes, groups directories and keeps restoration scoped to the selected stash', async () => {
  const user = userEvent.setup();
  const makeStash = (sha: string, message: string): StashEntry => ({
    sha,
    viewId: sha,
    selector: 'stash@{0}',
    message,
    date: '2026-10-10T10:00:00Z',
    base: 'a'.repeat(40),
    files: {
      kind: 'ready',
      items: [
        {
          path: 'src/nested/a.ts',
          originalPath: 'src/nested/a.ts',
          status: 'M',
          snapshot: 'working',
          oldRef: 'a'.repeat(40),
          newRef: sha,
          deleted: false,
        },
      ],
    },
  });
  const first = makeStash('b'.repeat(40), 'First stash');
  const second = makeStash('c'.repeat(40), 'Second stash');
  const app = session({
    ...initialState(),
    tab: 'stash',
    repositories: [
      { ...repository, stashes: { kind: 'ready', items: [first, second] } },
    ],
  });
  const toolbar = screen.getByRole('toolbar', { name: 'Stashes actions' });

  await user.click(within(toolbar).getByRole('button', { name: 'Refresh' }));
  expect(app.requests.at(-1)).toEqual({ kind: 'refresh' });
  const firstStash = within(
    screen.getByRole('region', { name: 'First stash' }),
  );
  const applyStash = within(toolbar).getByRole('button', {
    name: 'Apply Stash',
  });

  expect(applyStash).toBeDisabled();
  await user.click(within(toolbar).getByRole('button', { name: 'Expand All' }));
  expect(
    screen.getAllByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toHaveLength(2);
  await user.click(firstStash.getByRole('treeitem', { name: 'src/nested' }));
  expect(
    screen.getAllByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toHaveLength(1);
  await user.click(within(toolbar).getByRole('button', { name: 'Expand All' }));
  expect(
    screen.getAllByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toHaveLength(2);
  await user.click(
    within(toolbar).getByRole('button', { name: 'View Options' }),
  );
  await user.click(
    screen.getByRole('checkbox', { name: 'Group by Directory' }),
  );
  expect(screen.queryAllByRole('treeitem', { name: 'src' })).toHaveLength(0);
  expect(
    firstStash.getByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toHaveAttribute('aria-level', '1');
  await user.keyboard('{Escape}');
  await user.click(
    firstStash.getByRole('checkbox', { name: 'Include src/nested/a.ts' }),
  );
  await user.click(applyStash);
  expect(app.requests.at(-1)).toEqual({
    kind: 'restore-stash-files',
    repositoryId: 'root',
    sha: first.sha,
    files: [{ path: 'src/nested/a.ts', snapshot: 'working' }],
  });
  await user.click(
    screen.getByRole('button', { name: 'Collapse Second stash' }),
  );
  await user.click(applyStash);
  expect(app.requests.at(-1)).toEqual({
    kind: 'restore-stash',
    repositoryId: 'root',
    sha: second.sha,
  });
  await user.click(
    within(toolbar).getByRole('button', { name: 'Collapse All' }),
  );
  expect(screen.queryAllByRole('tree', { name: 'Saved files' })).toHaveLength(
    0,
  );
  await user.click(within(toolbar).getByRole('button', { name: 'Expand All' }));
  expect(screen.getAllByRole('tree', { name: 'Saved files' })).toHaveLength(2);
  expect(
    app.requests.filter(
      (request) =>
        request.kind === 'restore-stash' ||
        request.kind === 'restore-stash-files',
    ),
  ).toHaveLength(2);
  app.emit({
    ...app.state(),
    repositories: [
      { ...repository, stashes: { kind: 'ready', items: [first] } },
    ],
  });
  expect(applyStash).toBeDisabled();
  app.emit({ ...app.state(), repositories: [repository] });
  const refresh = within(toolbar).getByRole('button', { name: 'Refresh' });

  expect(refresh).toBeEnabled();
  expect(
    within(toolbar).getByRole('button', { name: 'Expand All' }),
  ).toBeDisabled();
  await user.click(refresh);
  expect(app.requests.at(-1)).toEqual({ kind: 'refresh' });
  app.emit({ ...app.state(), busy: true });
  expect(refresh).toBeDisabled();
});

test('keyboard folder and file selection persist collapse while tab arrows select the next view', async () => {
  const user = userEvent.setup();
  const app = session();
  const source = workingTree().getByRole('treeitem', { name: 'src' });

  source.focus();
  await user.keyboard(' ');
  expect(app.requests.at(-1)).toEqual({
    kind: 'check',
    repositoryId: 'root',
    paths: ['src/nested/a.ts', 'src/b.ts'],
    checked: true,
  });
  await user.keyboard('{ArrowRight}');
  expect(
    workingTree().getByRole('treeitem', { name: 'src/nested' }),
  ).toHaveFocus();
  source.focus();
  await user.keyboard('{ArrowLeft}');
  expect(source).toHaveAttribute('aria-expanded', 'false');
  expect(
    workingTree().queryByRole('treeitem', { name: 'src/nested/a.ts' }),
  ).toBeNull();
  expect(app.saved()).toMatchObject({ collapsed: [expect.any(String)] });
  app.emit({ ...app.state(), hoverDelay: 600 });
  expect(source).toHaveAttribute('aria-expanded', 'false');
  await user.keyboard('{ArrowRight}{ArrowDown}{ArrowDown}{Enter}');
  expect(app.requests.at(-1)).toEqual({
    kind: 'open-working',
    repositoryId: 'root',
    path: 'src/nested/a.ts',
    index: false,
  });
  screen.getByRole('tab', { name: 'Commit' }).focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Stashes' })).toHaveFocus();
  expect(app.requests.at(-1)).toEqual({ kind: 'tab', tab: 'stash' });
});

test('loading, errors and no repository stay usable and busy files cannot issue requests', () => {
  const app = session({
    ...initialState(),
    repositories: [],
    repositoryId: null,
  });

  expect(screen.getByText('No Git repositories found.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  app.emit({
    ...initialState(),
    repositories: [{ ...repository, changes: { kind: 'loading' } }],
  });
  expect(screen.getByRole('status')).toHaveTextContent('Loading changes');
  app.emit({
    ...initialState(),
    repositories: [
      { ...repository, changes: { kind: 'error', message: 'Unavailable' } },
    ],
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Unavailable')).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  app.emit({ ...initialState(), busy: true });
  const count = app.requests.length;

  fireEvent.click(screen.getByRole('treeitem', { name: 'src/b.ts' }));
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'src/b.ts' }), {
    key: 'Enter',
  });
  expect(app.requests).toHaveLength(count);
});

test('file badges and hover use the current working state after a staged rename', async () => {
  const user = userEvent.setup();

  session({
    ...initialState(),
    repositories: [
      {
        ...repository,
        changes: {
          kind: 'ready',
          items: [
            {
              ...repository.changes.items[0]!,
              path: 'new.ts',
              originalPath: 'new.ts',
              status: '??',
              staged: false,
              working: true,
              untracked: true,
            },
            {
              ...repository.changes.items[0]!,
              path: 'renamed.ts',
              originalPath: 'old.ts',
              status: 'RM',
              staged: true,
              working: true,
              untracked: false,
            },
          ],
        },
      },
    ],
  });
  const untracked = screen.getByRole('treeitem', { name: 'new.ts' });
  const renamed = workingTree().getByRole('treeitem', { name: 'renamed.ts' });

  expect(untracked).toHaveTextContent('U');
  expect(untracked).not.toHaveTextContent('??');
  expect(untracked).toHaveAccessibleDescription('Untracked');
  expect(renamed).toHaveTextContent('M');
  expect(renamed).not.toHaveTextContent('RM');
  expect(renamed).toHaveAccessibleDescription('Modified');
  await user.hover(within(renamed).getByText('renamed.ts'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent(
    '/workspace/renamed.ts • Modified',
  );
});

test.each([
  ['src/nested/a.ts', 'a.ts', 'Modified'],
  ['src/b.ts', 'b.ts', 'Modified'],
  ['staged.txt', 'staged.txt', 'Index Added'],
])(
  'the %s hover identifies its file status without changing inclusion',
  async (path, label, description) => {
    const user = userEvent.setup();
    const app = session();
    const file = within(
      screen.getByRole('tree', {
        name: path === 'staged.txt' ? 'Staged Changes' : 'Changes',
      }),
    ).getByRole('treeitem', { name: path });
    const count = app.requests.length;

    await user.hover(within(file).getByText(label, { exact: true }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(path);
    expect(screen.getByRole('tooltip')).toHaveTextContent(description);
    expect(file).toHaveAccessibleDescription(description);
    expect(app.requests).toHaveLength(count);
  },
);

test('restored stash expansion requests unloaded files only in the Stash tab', async () => {
  const user = userEvent.setup();
  const stash: StashEntry = {
    sha: 'b'.repeat(40),
    viewId: 'b'.repeat(40),
    selector: 'stash@{0}',
    message: 'Saved work',
    date: '2026-10-10T10:00:00Z',
    base: 'a'.repeat(40),
    files: null,
  };
  const app = session(
    {
      ...initialState(),
      repositories: [
        { ...repository, stashes: { kind: 'ready', items: [stash] } },
      ],
    },
    {
      repositoryId: 'root',
      tab: 'commit',
      collapsed: [],
      expandedStashes: [JSON.stringify(['root', 'stash', stash.sha])],
    },
  );

  expect(app.requests.some((request) => request.kind === 'load-stash')).toBe(
    false,
  );
  await user.click(screen.getByRole('tab', { name: 'Stashes' }));
  expect(app.requests.at(-1)).toEqual({
    kind: 'load-stash',
    repositoryId: 'root',
    sha: stash.sha,
  });
  app.emit({
    ...app.state(),
    repositories: [
      {
        ...repository,
        stashes: {
          kind: 'ready',
          items: [
            {
              ...stash,
              files: {
                kind: 'ready',
                items: [
                  {
                    path: 'only.txt',
                    originalPath: 'only.txt',
                    status: 'M',
                    snapshot: 'working',
                    oldRef: stash.base,
                    newRef: stash.sha,
                    deleted: false,
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  });
  expect(screen.getByRole('tree', { name: 'Saved files' })).toBeVisible();
  expect(screen.queryByText('Working files')).toBeNull();
  expect(screen.getByRole('button', { name: 'Apply Stash' })).toBeDisabled();
  const file = screen.getByRole('treeitem', { name: 'only.txt' });

  fireEvent.keyDown(file, { key: ' ' });
  expect(screen.getByRole('button', { name: 'Apply Stash' })).toBeEnabled();
  app.emit({ ...app.state(), busy: true });
  const count = app.requests.length;

  fireEvent.click(screen.getByRole('button', { name: 'Apply Stash' }));
  fireEvent.click(file);
  expect(app.requests).toHaveLength(count);
});

test('message typing survives delayed and older host acknowledgements and accepts a later generated draft', async () => {
  const user = userEvent.setup();
  const app = session(
    { ...initialState(), repositories: [{ ...repository, draft: 'Original' }] },
    null,
    false,
  );
  const message = screen.getByRole('textbox', { name: 'Commit message' });

  await user.clear(message);
  await user.type(message, 'Latest edit');
  expect(message).toHaveValue('Latest edit');
  expect(app.requests.at(-1)).toEqual({
    kind: 'message',
    repositoryId: 'root',
    message: 'Latest edit',
    editId: expect.any(String),
  });
  const latest = app.requests.at(-1);

  if (latest?.kind !== 'message')
    throw new Error('Expected the latest message edit');
  app.emit({
    ...app.state(),
    repositories: [{ ...repository, draft: 'L', draftEditId: 'older-edit' }],
  });
  expect(message).toHaveValue('Latest edit');
  app.emit({
    ...app.state(),
    repositories: [
      { ...repository, draft: 'Latest edit', draftEditId: latest.editId },
    ],
  });
  app.emit({
    ...app.state(),
    repositories: [{ ...repository, draft: 'Generated draft' }],
  });
  expect(message).toHaveValue('Generated draft');
  expect(message).toHaveAttribute('maxlength', '65536');
});

test('a refreshed tree retains a keyboard entry point when its active file disappears', () => {
  const app = session();
  const file = screen.getByRole('treeitem', { name: 'src/b.ts' });

  fireEvent.focus(file);
  app.emit({
    ...app.state(),
    repositories: [
      {
        ...repository,
        changes: {
          kind: 'ready',
          items: repository.changes.items.filter(
            (item) => item.path !== 'src/b.ts',
          ),
        },
      },
    ],
  });
  expect(screen.getByRole('treeitem', { name: 'Changes' })).toHaveAttribute(
    'tabindex',
    '0',
  );
});

test('clicking a completely unchecked folder includes every descendant', async () => {
  const user = userEvent.setup();
  const app = session({
    ...initialState(),
    repositories: [{ ...repository, checked: [] }],
  });

  await user.click(
    workingTree().getByRole('checkbox', { name: 'Include src' }),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'check',
    repositoryId: 'root',
    paths: ['src/nested/a.ts', 'src/b.ts'],
    checked: true,
  });
  expect(
    workingTree().getByRole('checkbox', {
      name: 'Include src/nested/a.ts',
    }),
  ).toBeChecked();
  expect(
    workingTree().getByRole('checkbox', { name: 'Include src/b.ts' }),
  ).toBeChecked();
});

test('unchecked folder clicks request inclusion before a delayed host reply', async () => {
  const user = userEvent.setup();
  const app = session(
    { ...initialState(), repositories: [{ ...repository, checked: [] }] },
    null,
    false,
  );

  await user.click(
    workingTree().getByRole('checkbox', { name: 'Include src' }),
  );
  expect(app.requests.at(-1)).toEqual({
    kind: 'check',
    repositoryId: 'root',
    paths: ['src/nested/a.ts', 'src/b.ts'],
    checked: true,
  });
  app.emit({
    ...app.state(),
    repositories: [{ ...repository, checked: ['src/nested/a.ts', 'src/b.ts'] }],
  });
  expect(
    workingTree().getByRole('checkbox', {
      name: 'Include src/nested/a.ts',
    }),
  ).toBeChecked();
  expect(
    workingTree().getByRole('checkbox', { name: 'Include src/b.ts' }),
  ).toBeChecked();
});

for (const scenario of [
  { name: 'repeated text', initial: '', values: ['a', 'ab', 'a'] },
  {
    name: 'clear and retype',
    initial: 'Original',
    values: ['', 'retyped', ''],
  },
])
  test(`draft acknowledgements preserve the newest edit with ${scenario.name}`, () => {
    const app = session(
      {
        ...initialState(),
        repositories: [{ ...repository, draft: scenario.initial }],
      },
      null,
      false,
    );
    const message = screen.getByRole('textbox', { name: 'Commit message' });

    for (const value of scenario.values)
      fireEvent.change(message, { target: { value } });
    const edits = app.requests.filter((request) => request.kind === 'message');
    const latest = edits.at(-1);

    if (!latest) throw new Error('Expected message edits');
    for (const edit of edits) {
      app.emit({
        ...app.state(),
        repositories: [
          { ...repository, draft: edit.message, draftEditId: edit.editId },
        ],
      });
      expect(message).toHaveValue(latest.message);
    }

    expect(new Set(edits.map((edit) => edit.editId)).size).toBe(3);
    app.emit({
      ...app.state(),
      repositories: [
        { ...repository, draft: 'Generated draft', draftEditId: null },
      ],
    });
    expect(message).toHaveValue('Generated draft');
  });

test('a busy host retries its dropped pending edit before enabling actions', async () => {
  const user = userEvent.setup();
  const app = session(
    { ...initialState(), repositories: [{ ...repository, draft: 'Original' }] },
    null,
    false,
  );
  const message = screen.getByRole('textbox', { name: 'Commit message' });
  const commit = screen.getByRole('button', { name: 'Commit' });
  const stash = screen.getByRole('button', { name: 'Stash Silently' });
  const generate = screen.getByRole('button', {
    name: 'Generate Commit Message',
  });

  fireEvent.change(message, { target: { value: 'Latest draft' } });
  const pending = app.requests.at(-1);

  if (pending?.kind !== 'message') throw new Error('Expected pending message');
  expect(message).toHaveValue('Latest draft');
  expect(commit).toBeDisabled();
  expect(stash).toBeDisabled();
  expect(generate).toBeDisabled();
  app.emit({ ...app.state(), busy: true });
  const requestCount = app.requests.length;

  app.emit({ ...app.state(), busy: false });
  expect(app.requests).toHaveLength(requestCount + 1);
  expect(app.requests.at(-1)).toEqual(pending);
  expect(message).toHaveValue('Latest draft');
  expect(commit).toBeDisabled();
  expect(stash).toBeDisabled();
  expect(generate).toBeDisabled();
  app.emit({ ...app.state(), hoverDelay: 600 });
  expect(app.requests).toHaveLength(requestCount + 1);
  app.emit({
    ...app.state(),
    reveal: null,
    repositories: [
      { ...repository, draft: pending.message, draftEditId: pending.editId },
    ],
  });
  expect(message).toHaveValue('Latest draft');
  expect(commit).toBeEnabled();
  expect(stash).toBeEnabled();
  expect(generate).toBeEnabled();
  await user.click(commit);
  expect(app.state().repositories[0]?.draft).toBe('Latest draft');
  expect(app.requests.at(-1)).toEqual({ kind: 'commit', repositoryId: 'root' });
});

test('a recreated staged deletion is shown on both sides but counted once for Commit', async () => {
  const user = userEvent.setup();
  const app = session({
    ...initialState(),
    repositories: [
      {
        ...repository,
        checked: [],
        changes: {
          kind: 'ready',
          items: [
            {
              path: 'recreated.txt',
              originalPath: 'recreated.txt',
              status: 'D ',
              staged: true,
              working: false,
              untracked: false,
            },
            {
              path: 'recreated.txt',
              originalPath: 'recreated.txt',
              status: '??',
              staged: false,
              working: true,
              untracked: true,
            },
          ],
        },
      },
    ],
  });

  await user.click(
    workingTree().getByRole('checkbox', { name: 'Include recreated.txt' }),
  );
  const summary = screen.getByRole('status', { name: 'Checked files summary' });

  expect(within(summary).getByText('U 1', { exact: true })).toBeVisible();
  expect(within(summary).queryByText('D 1', { exact: true })).toBeNull();
  expect(
    within(screen.getByRole('tree', { name: 'Staged Changes' })).getByRole(
      'checkbox',
      { name: 'Include recreated.txt' },
    ),
  ).toBeChecked();
  expect(app.state().repositories[0]!.checked).toEqual(['recreated.txt']);
});

test('selected revert recovery names its Abort action and explains its file scope', async () => {
  const active = {
    ...repository,
    changes: {
      ...repository.changes,
      items: repository.changes.items.map((file) =>
        file.path === 'src/b.ts'
          ? { ...file, status: 'UU', staged: true }
          : file,
      ),
    },
    operation: {
      kind: 'ready' as const,
      items: [
        {
          kind: 'revert-files' as const,
          token: 'a'.repeat(64),
          paths: ['src/b.ts'],
        },
      ],
    },
  };
  const s = session({ ...initialState(), repositories: [active] });
  const button = within(
    screen.getByRole('toolbar', { name: 'Changes actions' }),
  ).queryByRole('button', {
    name: 'Abort Selected Revert',
  });

  expect(button).not.toBeNull();
  expect(button).toHaveTextContent('');
  expect(button).toHaveAttribute(
    'aria-description',
    expect.stringContaining('unrelated'),
  );
  if (button) fireEvent.click(button);
  expect(s.requests).toContainEqual({
    kind: 'abort-operation',
    repositoryId: 'root',
    token: 'a'.repeat(64),
  });
  s.emit({ ...initialState(), repositories: [active], busy: true });
  expect(
    screen.getByRole('button', { name: 'Abort Selected Revert' }),
  ).toBeDisabled();
  s.emit({
    ...initialState(),
    repositories: [{ ...active, changes: repository.changes }],
  });
  expect(
    screen.queryByRole('button', { name: /Abort/ }),
  ).not.toBeInTheDocument();
});

test('Abort is hidden when there are no conflicts', () => {
  session();
  const button = within(
    screen.getByRole('toolbar', { name: 'Changes actions' }),
  ).queryByRole('button', { name: 'Abort' });

  expect(button).not.toBeInTheDocument();
});

test('lightweight draft ACKs enable actions and ignore old ACKs after the newest edit completes', async () => {
  const user = userEvent.setup();
  const app = session(initialState(), null, false);
  const message = screen.getByRole('textbox', { name: 'Commit message' });

  await user.type(message, 'Latest');
  const edits = app.requests.filter((request) => request.kind === 'message');
  const latest = edits.at(-1);
  const oldest = edits[0];

  if (!latest || !oldest) throw new Error('Expected message edits');
  const acknowledge = (request: typeof latest) =>
    act(() => {
      for (const listener of app.listeners)
        listener({
          kind: 'source-control-draft',
          repositoryId: request.repositoryId,
          message: request.message,
          editId: request.editId,
          generating: false,
        });
    });

  acknowledge(oldest);
  expect(message).toHaveValue('Latest');
  acknowledge(latest);
  expect(message).toHaveValue('Latest');
  expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled();
  acknowledge(oldest);
  expect(message).toHaveValue('Latest');
});
