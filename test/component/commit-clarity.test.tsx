import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type {
  SourceControlBridge,
  SourceControlRepository,
  SourceControlRequest,
  SourceControlResponse,
  SourceControlState,
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

function repository(): SourceControlRepository {
  return {
    pathLabel: { root: '/client-a/api', separator: '/' },
    info: {
      id: 'a',
      label: 'api',
      rootUri: 'file:///client-a/api',
      headSha: 'a'.repeat(40),
      branch: 'main',
    },
    changes: {
      kind: 'ready',
      items: [
        {
          path: 'a.txt',
          originalPath: 'a.txt',
          status: ' M',
          staged: false,
          working: true,
          untracked: false,
        },
      ],
    },
    stashes: { kind: 'ready', items: [] },
    operation: { kind: 'ready', items: [] },
    checked: ['a.txt'],
    draft: 'Keep this draft',
    draftEditId: null,
    commitMode: { kind: 'new' },
  };
}

function session(
  repo = repository(),
  options: {
    busy?: boolean;
    generating?: boolean;
    others?: SourceControlRepository[];
  } = {},
) {
  let state: SourceControlState = {
    hoverDelay: 0,
    repositories: [repo, ...(options.others ?? [])],
    repositoryId: repo.info.id,
    tab: 'commit',
    busy: options.busy ?? false,
    generating: options.generating ?? false,
    reveal: null,
  };
  const requests: SourceControlRequest[] = [];
  const listeners = new Set<(response: SourceControlResponse) => void>();
  const emit = (next: SourceControlState) => {
    state = next;
    act(() => {
      for (const listener of listeners)
        listener({ kind: 'source-control-state', state });
    });
  };

  const bridge: SourceControlBridge = {
    send(request) {
      requests.push(request);
      if (request.kind === 'repository')
        emit({ ...state, repositoryId: request.repositoryId });
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    getState: () => null,
    setState() {},
    dispose() {},
  };

  render(<SourceControlPage bridge={bridge} />);
  emit(state);

  return {
    requests,
    update(next: Partial<SourceControlRepository>) {
      emit({
        ...state,
        repositories: state.repositories.map((item) =>
          item.info.id === state.repositoryId ? { ...item, ...next } : item,
        ),
      });
    },
    acknowledge() {
      const edit = [...requests]
        .reverse()
        .find((request) => request.kind === 'message');

      if (edit?.kind !== 'message') throw new Error('No pending draft edit');
      act(() => {
        for (const listener of listeners)
          listener({
            kind: 'source-control-draft',
            repositoryId: edit.repositoryId,
            message: edit.message,
            editId: edit.editId,
            generating: false,
          });
      });
    },
  };
}

test('colliding repository names expose paths and keep repository IDs and drafts', async () => {
  const other = repository();

  other.info = { ...other.info, id: 'b', rootUri: 'file:///client-b/api' };
  other.pathLabel = { root: '/client-b/api', separator: '/' };
  other.draft = 'Other draft';
  const f = session(repository(), { others: [other] });

  expect(
    screen.getByRole('option', { name: 'api · /client-a/api' }),
  ).toHaveValue('a');
  expect(
    screen.getByRole('option', { name: 'api · /client-b/api' }),
  ).toHaveValue('b');
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Repository' }),
    'b',
  );
  expect(f.requests).toContainEqual({ kind: 'repository', repositoryId: 'b' });
  expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Other draft',
  );
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Repository' }),
    'a',
  );
  expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Keep this draft',
  );
});

test('distinct repository names stay concise', () => {
  const other = repository();

  other.info = { ...other.info, id: 'b', label: 'web' };
  session(repository(), { others: [other] });
  expect(screen.getByRole('option', { name: 'api' })).toHaveValue('a');
  expect(screen.getByRole('option', { name: 'web' })).toHaveValue('b');
});

test('commit destination follows branch updates without losing the message', () => {
  const f = session();

  expect(
    screen.getByRole('button', { name: 'Commit to main' }),
  ).toHaveAccessibleDescription(/Commit to main/);
  f.update({
    info: { ...repository().info, branch: 'feature/a-very-long-branch' },
  });
  expect(
    screen.getByRole('button', {
      name: 'Commit to feature/a-very-long-branch',
    }),
  ).toBeVisible();
  expect(
    screen.getByRole('button', { name: /^Commit(?: to |$)/ }),
  ).toHaveAccessibleDescription(/Commit to feature\/a-very-long-branch/);
  expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Keep this draft',
  );
});

test.each([
  {
    branch: null,
    headSha: '12345678' + 'a'.repeat(32),
    label: 'Detached HEAD · 12345678',
  },
  { branch: 'new-branch', headSha: null, label: 'new-branch' },
  { branch: null, headSha: null, label: 'Unborn HEAD' },
])('commit destination describes $label', ({ branch, headSha, label }) => {
  const repo = repository();

  repo.info = { ...repo.info, branch, headSha };
  session(repo);
  expect(
    screen.getByRole('button', { name: `Commit to ${label}` }),
  ).toBeVisible();
  expect(
    screen.getByRole('button', { name: /^Commit(?: to |$)/ }),
  ).toHaveAccessibleDescription(`Commit to ${label}. Ctrl+Enter to commit.`);
});

test.each(['ctrlKey', 'metaKey'] as const)(
  '%s+Enter submits the existing commit action once',
  (modifier) => {
    const f = session();
    const message = screen.getByRole('textbox', { name: 'Commit message' });

    fireEvent.keyDown(message, { key: 'Enter', [modifier]: true });
    fireEvent.keyDown(message, {
      key: 'Enter',
      [modifier]: true,
      repeat: true,
    });
    expect(f.requests.filter((request) => request.kind === 'commit')).toEqual([
      { kind: 'commit', repositoryId: 'a' },
    ]);
    expect(message).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+Enter Meta+Enter',
    );
    expect(message).toHaveAttribute(
      'placeholder',
      'Commit message (Ctrl+Enter)',
    );
  },
);

test('ordinary Enter keeps adding message lines, while composition and unrelated modifier chords never submit', async () => {
  const f = session();
  const message = screen.getByRole('textbox', { name: 'Commit message' });

  await userEvent.click(message);
  await userEvent.keyboard('{End}{Enter}More');
  expect(message).toHaveValue('Keep this draft\nMore');
  f.acknowledge();
  fireEvent.keyDown(message, {
    key: 'Enter',
    ctrlKey: true,
    isComposing: true,
  });
  fireEvent.keyDown(message, { key: 'Enter', metaKey: true, keyCode: 229 });
  fireEvent.keyDown(message, { key: 'Enter', ctrlKey: true, altKey: true });
  fireEvent.keyDown(message, { key: 'Enter', metaKey: true, shiftKey: true });
  expect(f.requests.filter((request) => request.kind === 'commit')).toEqual([]);
});

test.each([
  {
    name: 'blank message',
    patch: { draft: '  ' },
    reason: 'Enter a commit message.',
  },
  {
    name: 'zero checked files',
    patch: { checked: [] },
    reason: 'Check at least one changed file.',
  },
  {
    name: 'loading changes',
    patch: { changes: { kind: 'loading' } },
    reason: 'Wait for changes to load.',
  },
  {
    name: 'failed changes',
    patch: { changes: { kind: 'error', message: 'Read failed' } },
    reason: 'Refresh changes before committing.',
  },
] satisfies {
  name: string;
  patch: Partial<SourceControlRepository>;
  reason: string;
}[])(
  '$name explains the disabled action to keyboard users and blocks shortcuts',
  async ({ patch, reason }) => {
    const f = session({ ...repository(), ...patch });
    const action = screen.getByRole('button', { name: /^Commit(?: to |$)/ });

    expect(action).toBeDisabled();
    expect(action).toHaveAccessibleDescription(expect.stringContaining(reason));
    const explanation = screen.getByRole('group', {
      name: 'Commit unavailable',
    });

    expect(explanation).toHaveAttribute('tabindex', '0');
    act(() => explanation.focus());
    expect(explanation).toHaveFocus();
    expect(explanation).toHaveAccessibleDescription(
      expect.stringContaining(reason),
    );
    expect(await screen.findByRole('tooltip')).toHaveTextContent(reason);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Commit message' }), {
      key: 'Enter',
      ctrlKey: true,
    });
    expect(f.requests.filter((request) => request.kind === 'commit')).toEqual(
      [],
    );
  },
);

test.each([
  {
    busy: true,
    generating: false,
    reason: 'Wait for the current operation to finish.',
  },
  {
    busy: false,
    generating: true,
    reason: 'Wait for message generation to finish.',
  },
])(
  'transient state $reason blocks the shortcut without a visible status reason',
  ({ busy, generating, reason }) => {
    const f = session(repository(), { busy, generating });

    expect(
      screen.getByRole('button', { name: /^Commit(?: to |$)/ }),
    ).toHaveAccessibleDescription(expect.stringContaining(reason));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Commit message' }), {
      key: 'Enter',
      metaKey: true,
    });
    expect(f.requests.filter((request) => request.kind === 'commit')).toEqual(
      [],
    );
    expect(
      screen
        .queryAllByRole('status')
        .some((status) => status.textContent?.includes(reason)),
    ).toBe(false);
  },
);

test('a pending draft blocks submission until acknowledged and does not queue a commit', () => {
  const f = session();
  const message = screen.getByRole('textbox', { name: 'Commit message' });

  fireEvent.change(message, { target: { value: 'Edited message' } });
  expect(
    screen.getByRole('button', { name: /^Commit(?: to |$)/ }),
  ).toHaveAccessibleDescription(/Wait for the commit message to be saved/);
  fireEvent.keyDown(message, { key: 'Enter', ctrlKey: true });
  expect(f.requests.filter((request) => request.kind === 'commit')).toEqual([]);
  f.acknowledge();
  expect(f.requests.filter((request) => request.kind === 'commit')).toEqual([]);
  fireEvent.keyDown(message, { key: 'Enter', ctrlKey: true });
  expect(f.requests.filter((request) => request.kind === 'commit')).toEqual([
    { kind: 'commit', repositoryId: 'a' },
  ]);
});

test('amend permits zero checked files and shares destination and submission with the button', () => {
  const f = session({
    ...repository(),
    checked: [],
    commitMode: { kind: 'amend', headSha: 'a'.repeat(40) },
  });
  const action = screen.getByRole('button', { name: 'Amend Commit on main' });

  expect(action).toBeEnabled();
  expect(action).toHaveAccessibleDescription(
    'Amend Commit on main. Ctrl+Enter to commit.',
  );
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Commit message' }), {
    key: 'Enter',
    metaKey: true,
  });
  fireEvent.click(action);
  expect(f.requests.filter((request) => request.kind === 'commit')).toEqual([
    { kind: 'commit', repositoryId: 'a' },
    { kind: 'commit', repositoryId: 'a' },
  ]);
});
