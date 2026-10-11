import { basename } from 'node:path';

import type { Browser, Frame, Locator } from '@playwright/test';
import { chromium, expect } from '@playwright/test';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../../src/shared/extension-identity';

declare global {
  var nativeTestBrowser: Browser | undefined;
}
export async function nativeBrowser(): Promise<Browser> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);

  if (!extension) throw new Error('Git UI is not installed in the test host.');
  await extension.activate();
  globalThis.nativeTestBrowser ??= await chromium.connectOverCDP(
    `http://127.0.0.1:${process.env.VSCODE_TEST_DEBUG_PORT ?? ''}`,
  );
  const workbench = globalThis.nativeTestBrowser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes('/workbench/workbench.html'));

  if (!workbench) throw new Error('Native VS Code workbench did not load.');
  await workbench.bringToFront();

  return globalThis.nativeTestBrowser;
}

export async function nativePanel(repositoryId: string): Promise<Frame> {
  const browser = await nativeBrowser();
  let frame: Frame | undefined;

  await expect
    .poll(async () => {
      for (const context of browser.contexts())
        for (const page of context.pages())
          for (const candidate of page.frames()) {
            if (candidate.isDetached()) continue;
            const row = candidate.locator('[data-commit-row]').first();

            if (!(await row.count())) continue;
            const encoded = await row
              .getAttribute('data-vscode-context', {
                timeout: 100,
              })
              .catch(() => null);

            if (!encoded) continue;
            const current = JSON.parse(encoded) as {
              repositoryId: string;
            };

            if (current.repositoryId === repositoryId) {
              frame = candidate;

              return true;
            }
          }

      return false;
    })
    .toBe(true);

  if (!frame) throw new Error('Native Git history panel did not load.');

  return frame;
}

export async function selectNativeRepository(
  repositoryId: string,
): Promise<Frame> {
  const browser = await nativeBrowser();
  let frame: Frame | undefined;

  await expect
    .poll(
      async () => {
        for (const context of browser.contexts())
          for (const page of context.pages())
            for (const candidate of page.frames())
              if (
                !candidate.isDetached() &&
                (await candidate.locator('#log-tab').count())
              ) {
                frame = candidate;

                return true;
              }

        return false;
      },
      { timeout: 15000 },
    )
    .toBe(true)
    .catch(async (error: unknown) => {
      const documents = await Promise.all(
        browser.contexts().flatMap((context) =>
          context.pages().flatMap((page) =>
            page.frames().map(async (candidate) => ({
              url: candidate.url().replace(/\?.*$/, ''),
              content: await candidate
                .evaluate(() => ({
                  ready: document.readyState,
                  visibility: document.visibilityState,
                  focused: document.hasFocus(),
                  text: document.body?.innerText.slice(0, 600),
                  scripts: [...document.scripts].map((script) => script.src),
                  iframes: [...document.querySelectorAll('iframe')].map(
                    (iframe) => ({
                      src: iframe.src.replace(/\?.*$/, ''),
                      title: iframe.title,
                    }),
                  ),
                }))
                .catch(() => null),
            })),
          ),
        ),
      );
      const session = await browser.newBrowserCDPSession();
      let targets: unknown;

      try {
        targets = await session.send('Target.getTargets').then((result) =>
          result.targetInfos.map(({ type, url }) => ({
            type,
            url: url.replace(/\?.*$/, ''),
          })),
        );
      } finally {
        await session.detach();
      }

      throw new Error(
        `Native Git view did not load: ${JSON.stringify({ documents, targets })}`,
        { cause: error },
      );
    });

  if (!frame) throw new Error('Native Git history panel did not load.');
  await frame.page().bringToFront();
  await frame.getByRole('tab', { name: 'Log', exact: true }).click();
  await vscode.commands.executeCommand('notifications.hideToasts');
  const picker = frame.getByRole('button', {
    name: 'Select repository',
    exact: true,
  });

  if (await picker.isVisible()) {
    await picker.click();
    const input = frame
      .page()
      .getByPlaceholder('Select repository', { exact: true });

    await input.fill(basename(vscode.Uri.parse(repositoryId).fsPath));
    await expect(
      frame.page().locator('.quick-input-list .monaco-list-row'),
    ).toHaveCount(1);
    await input.press('Enter');
  }

  return nativePanel(repositoryId);
}

export function trackNativeDrafts(): { dispose(): Promise<void> } {
  const drafts = new Set<vscode.TextDocument>();
  const subscription = vscode.workspace.onDidOpenTextDocument((document) => {
    if (document.uri.scheme === 'untitled') drafts.add(document);
  });

  return {
    async dispose() {
      subscription.dispose();
      const errors: unknown[] = [];

      for (const document of drafts) {
        if (document.isClosed) continue;
        try {
          await vscode.window.showTextDocument(document, { preview: false });
          await vscode.commands.executeCommand(
            'workbench.action.revertAndCloseActiveEditor',
          );
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length)
        throw new AggregateError(errors, 'Could not close native test drafts.');
    },
  };
}

export async function refreshNativeHistory(
  frame: Frame,
  repositoryId: string,
): Promise<Locator> {
  const row = frame
    .locator('#history-pane[aria-busy="false"] [data-commit-row]')
    .first();
  const previous = JSON.parse(
    (await row.getAttribute('data-vscode-context'))!,
  ) as { generation: number };

  // Fixture cleanup can leave native toasts over the webview's toolbar.
  await vscode.commands.executeCommand('notifications.hideToasts');
  await frame.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect
    .poll(async () => {
      const context = JSON.parse(
        (await row.getAttribute('data-vscode-context'))!,
      ) as { generation: number; repositoryId: string };

      return context.repositoryId === repositoryId ? context.generation : 0;
    })
    .toBeGreaterThan(previous.generation);

  return row;
}
