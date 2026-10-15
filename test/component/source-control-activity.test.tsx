import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type {
  SourceControlBridge,
  SourceControlResponse,
  SourceControlState,
} from '../../src/shared/source-control';
import { SourceControlPage } from '../../src/webview/pages/source-control';

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const listeners = new Set<(response: SourceControlResponse) => void>();
  const state: SourceControlState = {
    hoverDelay: 500,
    repositoryId: 'repo',
    tab: 'commit',
    busy: false,
    generating: false,
    reveal: null,
    repositories: [
      {
        info: {
          id: 'repo',
          rootUri: 'file:///repo',
          label: 'repo',
          branch: 'main',
          headSha: 'a'.repeat(40),
        },
        pathLabel: { root: '/repo', separator: '/' },
        changes: {
          kind: 'ready',
          items: [
            {
              path: 'sample.txt',
              originalPath: 'sample.txt',
              status: ' M',
              staged: false,
              working: true,
              untracked: false,
            },
          ],
        },
        checked: ['sample.txt'],
        draft: 'My commit',
        draftEditId: null,
        stashes: { kind: 'ready', items: [] },
        operation: { kind: 'ready', items: [] },
        commitMode: { kind: 'new' },
      },
    ],
  };
  const bridge: SourceControlBridge = {
    send() {},
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    getState: () => undefined,
    setState() {},
    dispose() {},
  };

  render(<SourceControlPage bridge={bridge} />);
  const emit = (next: SourceControlState) =>
    act(() => {
      for (const listener of listeners)
        listener({ kind: 'source-control-state', state: next });
    });

  emit(state);

  return { state, emit };
}

test('Source Control announces the current action and clears it after completion', () => {
  const { state, emit } = fixture();

  emit({
    ...state,
    busy: true,
    activity: { repositoryId: 'repo', title: 'Committing checked files…' },
  });
  expect(
    screen.getByRole('status', { name: 'Source Control activity' }),
  ).toHaveTextContent('Committing checked files…');
  expect(
    screen.getByRole('region', { name: 'Source Control' }),
  ).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  emit(state);
  expect(
    screen.queryByRole('status', { name: 'Source Control activity' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('region', { name: 'Source Control' }),
  ).toHaveAttribute('aria-busy', 'false');
});

test('Amend announces read activity while keeping file inclusion and the draft editable', () => {
  const { state, emit } = fixture();

  emit({
    ...state,
    activity: { repositoryId: 'repo', title: 'Loading last commit…' },
  });
  expect(
    screen.getByRole('status', { name: 'Source Control activity' }),
  ).toHaveTextContent('Loading last commit…');
  expect(screen.getByRole('textbox', { name: 'Commit message' })).toBeEnabled();
  expect(
    screen.getByRole('checkbox', { name: 'Include sample.txt' }),
  ).toBeEnabled();
});
