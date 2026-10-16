import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

import type { PanelBody, Result } from '../../src/shared/messages';
import { App } from '../../src/webview/app/layout/App';
import { createBrowserBridge } from '../../src/webview/shared/api';

const repository = {
  id: 'one',
  label: 'One',
  rootUri: 'file:///one',
  branch: 'main',
  headSha: 'a'.repeat(40),
};
const history: Extract<PanelBody, { kind: 'history' }> = {
  kind: 'history',
  repository,
  scope: { kind: 'head' },
  text: '',
  append: false,
  page: {
    commits: [
      {
        sha: repository.headSha,
        parents: [],
        message: 'Loaded commit',
        authorName: null,
        authorEmail: null,
        authorDate: null,
        commitDate: null,
      },
    ],
    refs: [
      {
        id: 'refs/heads/main',
        name: 'main',
        kind: 'local',
        sha: repository.headSha,
        remote: null,
        tracking: {
          upstream: 'refs/remotes/origin/main',
          ahead: 0,
          behind: 3,
        },
      },
    ],
    nextCursor: null,
    scopeId: 'fixture',
  },
};

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

function loadedApp() {
  const target = new EventTarget();
  const bridge = createBrowserBridge(
    { getState: () => null, setState: () => {}, postMessage: () => {} },
    target,
  );

  onTestFinished(() => bridge.dispose());
  const rendered = render(<App bridge={bridge} />);
  const deliver = (body: PanelBody) => {
    act(() => {
      target.dispatchEvent(
        new MessageEvent<Result<PanelBody>>('message', {
          data: { repositoryId: 'one', requestId: 'host', generation: 1, body },
        }),
      );
    });
  };

  deliver(history);

  return { ...rendered, deliver };
}

for (const phase of ['waiting', 'queued', 'running'] as const)
  test(`Fetch keeps its toolbar loading indicator while ${phase} without starting history activity`, () => {
    const { container, deliver } = loadedApp();
    const fetch = {
      label: 'Fetching remotes…',
      refIds: [],
      section: 'branches' as const,
    };

    deliver({
      kind: 'operation-progress',
      operation:
        phase === 'queued'
          ? {
              label: 'Updating main…',
              refIds: ['refs/heads/main'],
              phase: 'running',
              queued: [fetch],
            }
          : { ...fetch, phase },
    });
    expect(
      screen.getByRole('button', { name: 'Fetch All Remotes' }),
    ).toHaveAttribute('aria-busy', 'true');
    expect(
      container.querySelector('#fetch .codicon-loading'),
    ).toBeInTheDocument();
    expect(container.querySelector('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    deliver({ kind: 'operation-progress', operation: null });
    expect(
      screen.getByRole('button', { name: 'Fetch All Remotes' }),
    ).toHaveAttribute('aria-busy', 'false');
    expect(container.querySelector('#fetch .codicon-loading')).toBeNull();
  });

for (const phase of ['loading', 'settled'] as const)
  test(`interrupting ${phase} history keeps the displayed rows inactive without keeping its loader`, () => {
    const { container, deliver } = loadedApp();

    expect(container.querySelector('[data-history-content]')).toHaveStyle({
      height: '22px',
    });
    if (phase === 'loading')
      deliver({
        kind: 'loading',
        repository,
        preserve: true,
        scope: { kind: 'head' },
        text: '',
      });
    deliver({ kind: 'history-interrupted' });
    expect(
      JSON.parse(
        container
          .querySelector('[data-ref="refs/heads/main"]')!
          .getAttribute('data-vscode-context')!,
      ).logOperationBusy,
    ).toBe(true);
    deliver({
      kind: 'operation-progress',
      operation: {
        label: 'Updating main…',
        refIds: ['refs/heads/main'],
        section: 'branches',
        phase: 'running',
      },
    });

    expect(container.querySelector('[data-history-content]')).toHaveStyle({
      height: '22px',
    });
    expect(container.querySelector('#history')).toHaveAttribute('inert', '');
    expect(container.querySelector('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    expect(
      container.querySelector('#history-pane > [aria-hidden="true"]'),
    ).toBeNull();
    expect(container.querySelector('#status')).not.toHaveTextContent(
      'No commits',
    );

    expect(
      container.querySelector('#branches .codicon-loading'),
    ).toBeInTheDocument();
    deliver({ ...history, page: { ...history.page, commits: [] } });
    expect(container.querySelector('[data-history-content]')).toHaveStyle({
      height: '0px',
    });
    expect(container.querySelector('#history')).not.toHaveAttribute(
      'inert',
      '',
    );
    expect(container.querySelector('#status')).toHaveTextContent('No commits');
  });

test('a waiting branch action keeps the loading indicator and its waiting description', () => {
  const { container, deliver } = loadedApp();

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Updating main…',
      refIds: ['refs/heads/main'],
      section: 'branches',
      phase: 'waiting',
    },
  });
  expect(
    container.querySelector('#branches .codicon-loading'),
  ).toBeInTheDocument();
  expect(container.querySelector('#branches .codicon-clock')).toBeNull();
  expect(screen.getByLabelText('Queued: Updating main…')).toBeInTheDocument();
});

test('queued history actions show waiting feedback without pretending to execute', () => {
  const { container, deliver } = loadedApp();

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Updating main…',
      refIds: ['refs/heads/main'],
      section: 'branches',
      phase: 'running',
      queued: [
        {
          label: 'Cherry-picking selected changes…',
          refIds: [],
          section: 'history',
        },
      ],
    },
  });
  expect(screen.getByRole('status')).toHaveTextContent(
    'Queued: Cherry-picking selected changes…',
  );
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
});

test('Worktrees reads show local activity and clear it when the read finishes', () => {
  const { container, deliver } = loadedApp();

  fireEvent.click(screen.getByRole('tab', { name: 'Worktrees' }));
  deliver({ kind: 'worktrees-loading', loading: true });
  expect(screen.getByRole('region', { name: 'Worktrees' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(screen.queryByText('No worktrees to show.')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing worktrees…');
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  deliver({ kind: 'worktrees-loading', loading: false });
  expect(screen.getByRole('region', { name: 'Worktrees' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
});

test('a Worktrees error leaves an independent history read running', () => {
  const { container, deliver } = loadedApp();

  deliver({ kind: 'loading', repository, scope: { kind: 'head' }, text: '' });
  deliver({ kind: 'worktrees-error', message: 'Worktree unavailable' });
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Worktrees' }));
  expect(screen.getByText('Worktree unavailable')).toBeVisible();
});

test('a running branch update spins its row while loaded history remains idle', () => {
  const { container, deliver } = loadedApp();

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Updating main…',
      refIds: ['refs/heads/main'],
      phase: 'running',
    },
  });
  expect(screen.getByLabelText('Updating main…')).toBeInTheDocument();
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(
    container.querySelector('#history-pane > [aria-hidden="true"]'),
  ).toBeNull();
  expect(container.querySelector('#status')).not.toBeVisible();
});

test('finishing the branch write hides cached tracking before a history query starts', () => {
  const { container, deliver } = loadedApp();

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Updating main…',
      refIds: ['refs/heads/main'],
      phase: 'refreshing',
    },
  });
  expect(container.querySelector('#branches .codicon-loading')).toBeNull();
  expect(container.querySelector('[data-incoming]')).toBeNull();
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(container.querySelector('#status')).not.toBeVisible();

  deliver({
    kind: 'loading',
    repository,
    preserve: true,
    scope: { kind: 'head' },
    text: '',
  });
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(
    container.querySelector('#history-pane > [aria-hidden="true"]'),
  ).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing history…');
  expect(container.querySelector('#branches .codicon-loading')).toBeNull();
  expect(container.querySelector('[data-incoming]')).toBeNull();

  deliver(history);
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(container.querySelector('#status')).not.toBeVisible();
});

for (const outcome of ['updated', 'unchanged', 'unavailable'] as const)
  test(`Fetch hides old incoming and outgoing counts until ${outcome} references settle`, () => {
    const { container, deliver } = loadedApp();
    const refs = (history.page.refs ?? []).map((ref) => ({
      ...ref,
      tracking: {
        upstream: 'refs/remotes/origin/main',
        ahead: 2,
        behind: 3,
      },
    }));

    deliver({ kind: 'references', references: refs });
    expect(container.querySelector('[data-incoming]')).toHaveTextContent('3');
    expect(container.querySelector('[data-outgoing]')).toHaveTextContent('2');
    deliver({
      kind: 'operation-progress',
      operation: {
        label: 'Fetching remotes…',
        refIds: [],
        section: 'branches',
        phase: 'refreshing',
      },
    });
    expect(container.querySelector('#fetch .codicon-loading')).toBeNull();
    expect(container.querySelector('[data-incoming]')).toBeNull();
    expect(container.querySelector('[data-outgoing]')).toBeNull();

    if (outcome === 'unavailable') {
      deliver({ kind: 'error', message: 'References unavailable' });
      deliver({ kind: 'operation-progress', operation: null });
      expect(container.querySelector('[data-incoming]')).toBeNull();
      expect(container.querySelector('[data-outgoing]')).toBeNull();
    }

    deliver({
      kind: 'references',
      references:
        outcome === 'updated'
          ? refs.map((ref) => ({
              ...ref,
              tracking: { ...ref.tracking, ahead: 1, behind: 0 },
            }))
          : refs,
    });
    deliver({ kind: 'operation-progress', operation: null });
    if (outcome === 'updated')
      expect(container.querySelector('[data-incoming]')).toBeNull();
    else
      expect(container.querySelector('[data-incoming]')).toHaveTextContent('3');
    expect(container.querySelector('[data-outgoing]')).toHaveTextContent(
      outcome === 'updated' ? '1' : '2',
    );
    expect(container.querySelector('#history-pane')).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });

test('a branch action leaves Worktrees idle after switching views', () => {
  const { container, deliver } = loadedApp();

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Updating main…',
      refIds: ['refs/heads/main'],
      phase: 'running',
    },
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Worktrees' }));
  expect(screen.getByRole('region', { name: 'Worktrees' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(
    container.querySelector('#worktrees-view > [aria-hidden="true"]'),
  ).toBeNull();
  expect(container.querySelector('#status')).not.toBeVisible();
});

test('worktree progress stays in Worktrees and stops when its Git write finishes', () => {
  const { container, deliver } = loadedApp();

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Creating worktree…',
      refIds: ['refs/heads/main'],
      section: 'worktrees',
      phase: 'running',
    },
  });
  expect(container.querySelector('#branches .codicon-loading')).toBeNull();
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(container.querySelector('#status')).not.toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'Worktrees' }));
  expect(screen.getByRole('region', { name: 'Worktrees' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(
    container.querySelector('#worktrees-view > [aria-hidden="true"]'),
  ).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Creating worktree…');

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Creating worktree…',
      refIds: ['refs/heads/main'],
      section: 'worktrees',
      phase: 'refreshing',
    },
  });
  expect(screen.getByRole('region', { name: 'Worktrees' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(container.querySelector('#status')).not.toBeVisible();
});

test('history writes show Log activity while branch rows and Worktrees remain idle', () => {
  const { container, deliver } = loadedApp();

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Dropping commits…',
      refIds: ['refs/heads/main'],
      section: 'history',
      phase: 'running',
    },
  });
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(
    container.querySelector('#history-pane > [aria-hidden="true"]'),
  ).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Dropping commits…');
  expect(container.querySelector('#branches .codicon-loading')).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: 'Worktrees' }));
  expect(screen.getByRole('region', { name: 'Worktrees' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(container.querySelector('#status')).not.toBeVisible();

  deliver({
    kind: 'operation-progress',
    operation: {
      label: 'Dropping commits…',
      refIds: ['refs/heads/main'],
      section: 'history',
      phase: 'refreshing',
    },
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Log' }));
  expect(container.querySelector('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  expect(
    container.querySelector('#history-pane > [aria-hidden="true"]'),
  ).toBeNull();
  expect(container.querySelector('#status')).not.toBeVisible();
});
