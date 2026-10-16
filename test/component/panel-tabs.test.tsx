import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { App } from '../../src/webview/app/layout/App';
import { createBrowserBridge } from '../../src/webview/shared/api';

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

test('Log and Worktrees use one tab stop, linked mounted panels, and arrow/Home/End navigation', () => {
  const bridge = createBrowserBridge(
    { getState: () => null, setState() {}, postMessage() {} },
    new EventTarget(),
  );
  const { unmount } = render(<App bridge={bridge} />);
  const log = screen.getByRole('tab', { name: 'Log' });
  const worktrees = screen.getByRole('tab', { name: 'Worktrees' });
  const logPanel = screen.getByRole('tabpanel', { name: 'Log' });
  const worktreesPanel = screen
    .getAllByRole('tabpanel', { hidden: true })
    .find((panel) => panel.id === 'worktrees-panel');

  expect(worktreesPanel).toBeInTheDocument();
  expect(log).toHaveAttribute('aria-controls', logPanel.id);
  expect(worktrees).toHaveAttribute('aria-controls', worktreesPanel?.id);
  expect(logPanel).toHaveAttribute('aria-labelledby', log.id);
  expect(worktreesPanel).toHaveAttribute('aria-labelledby', worktrees.id);
  expect(log).toHaveAttribute('tabindex', '0');
  expect(worktrees).toHaveAttribute('tabindex', '-1');
  expect(worktreesPanel).not.toBeVisible();

  log.focus();
  for (const [key, selected, other] of [
    ['ArrowRight', worktrees, log],
    ['ArrowRight', log, worktrees],
    ['ArrowLeft', worktrees, log],
    ['Home', log, worktrees],
    ['End', worktrees, log],
  ] satisfies [string, HTMLElement, HTMLElement][]) {
    fireEvent.keyDown(document.activeElement ?? log, { key });
    expect(selected).toHaveFocus();
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(selected).toHaveAttribute('tabindex', '0');
    expect(other).toHaveAttribute('aria-selected', 'false');
    expect(other).toHaveAttribute('tabindex', '-1');
  }

  expect(screen.getByRole('tabpanel', { name: 'Worktrees' })).toBe(
    worktreesPanel,
  );
  expect(logPanel).toBeInTheDocument();
  expect(logPanel).not.toBeVisible();
  fireEvent.click(log);
  expect(screen.getByRole('tabpanel', { name: 'Log' })).toBe(logPanel);
  expect(worktreesPanel).toBeInTheDocument();
  unmount();
  bridge.dispose();
});
