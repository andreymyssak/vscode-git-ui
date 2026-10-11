import assert from 'node:assert/strict';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';

import { CHANGES_VIEW_ID } from '../../src/shared/extension-identity';
import { nativeBrowser } from './native-panel';

export async function sourceControlFrame(): Promise<Frame> {
  const browser = await nativeBrowser();
  let frame: Frame | undefined;

  await vscode.commands.executeCommand(`${CHANGES_VIEW_ID}.focus`);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('/workbench/workbench.html'));

  assert.ok(page);
  // Give the combined view the space a user gets by hiding the built-in views.
  for (const name of ['Changes', 'Graph']) {
    const header = page.getByRole('button', {
      name: `${name} Section`,
      exact: true,
    });

    if (
      (await header.count()) &&
      (await header.getAttribute('aria-expanded')) === 'true'
    ) {
      await header.locator('.twisty-container').click();
      await expect(header).toHaveAttribute('aria-expanded', 'false');
    }
  }

  await expect
    .poll(
      async () => {
        for (const context of browser.contexts())
          for (const page of context.pages())
            for (const candidate of page.frames())
              if (
                !candidate.isDetached() &&
                (await candidate.locator('[data-source-control]').count())
              ) {
                frame = candidate;

                return true;
              }

        return false;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  assert.ok(frame);
  const activeFrame = frame;

  // The view command can return before its document has loaded and can receive focus.
  await activeFrame.page().bringToFront();
  await vscode.commands.executeCommand(`${CHANGES_VIEW_ID}.focus`);
  await activeFrame.getByRole('tab', { name: 'Commit', exact: true }).click();
  await expect(
    activeFrame.getByRole('tab', { name: 'Commit', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await activeFrame.getByRole('tab', { name: 'Commit', exact: true }).focus();
  await expect
    .poll(() => activeFrame.evaluate(() => document.hasFocus()))
    .toBe(true);

  return activeFrame;
}
