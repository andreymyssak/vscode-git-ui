import { expect, test } from '@playwright/test';

import type { SourceControlState } from '../../src/shared/source-control';

for (const width of [220, 320])
  test(`Git state groups and linked checkboxes fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/source-control.html');
    const state: SourceControlState = {
      hoverDelay: 500,
      busy: false,
      generating: false,
      reveal: null,
      repositoryId: 'repo',
      tab: 'commit',
      repositories: [
        {
          info: {
            id: 'repo',
            label: 'Example',
            rootUri: 'file:///example',
            headSha: 'a'.repeat(40),
            branch: 'main',
          },
          pathLabel: { root: '/example', separator: '/' },
          checked: [],
          draft: '',
          draftEditId: null,
          operation: {
            kind: 'ready',
            items: [
              {
                kind: 'revert-files',
                token: 'a'.repeat(64),
                paths: ['conflict.ts'],
              },
            ],
          },
          commitMode: { kind: 'new' },
          stashes: { kind: 'ready', items: [] },
          changes: {
            kind: 'ready',
            items: [
              {
                path: 'src/partial.ts',
                originalPath: 'src/partial.ts',
                status: 'MM',
                staged: true,
                working: true,
                untracked: false,
              },
              {
                path: 'conflict.ts',
                originalPath: 'conflict.ts',
                status: 'UU',
                staged: true,
                working: true,
                untracked: false,
              },
              {
                path: 'staged.ts',
                originalPath: 'staged.ts',
                status: 'A ',
                staged: true,
                working: false,
                untracked: false,
              },
            ],
          },
        },
      ],
    };

    await page.evaluate(
      (state) =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { kind: 'source-control-state', state },
          }),
        ),
      state,
    );
    const working = page.getByRole('tree', { name: 'Changes', exact: true });
    const abort = page.getByRole('button', { name: 'Abort Selected Revert' });

    await expect(abort).toBeVisible();
    await expect(abort).toHaveAttribute('aria-description', /keep unrelated/);
    await abort.hover();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 1000 });
    await expect(page.getByRole('tooltip')).toContainText(
      'Abort Selected Revert',
    );
    await page.getByRole('tab', { name: 'Commit', exact: true }).hover();
    const abortBox = await abort.boundingBox();
    const toolbarBox = await page
      .getByRole('toolbar', { name: 'Changes actions' })
      .boundingBox();

    expect(abortBox!.x + abortBox!.width).toBeCloseTo(
      toolbarBox!.x + toolbarBox!.width - 5,
      0,
    );
    await expect(abort).toHaveCSS('color', 'rgb(241, 76, 76)');
    const staged = page.getByRole('tree', {
      name: 'Staged Changes',
      exact: true,
    });
    const merge = page.getByRole('tree', {
      name: 'Merge Changes',
      exact: true,
    });

    for (const [tree, label, count] of [
      [merge, 'Merge Changes', 1],
      [staged, 'Staged Changes', 2],
      [working, 'Changes', 1],
    ] as const) {
      const header = tree.getByRole('treeitem', { name: label, exact: true });

      await expect(header).toBeVisible();
      await expect(header).toContainText(
        `${count} ${count === 1 ? 'file' : 'files'}`,
      );
      const box = await header.boundingBox();

      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }

    // The component contract covers host acknowledgements; this checks native pointer routing and row layout.
    const row = working.getByRole('treeitem', {
      name: 'src/partial.ts',
      exact: true,
    });

    await row.getByRole('checkbox').click();
    await expect(row.getByRole('checkbox')).toBeChecked();
    await expect(
      staged.getByRole('checkbox', {
        name: 'Include src/partial.ts',
        exact: true,
      }),
    ).toBeChecked();
    await expect(
      page.getByRole('status', { name: 'Checked files summary' }),
    ).toContainText('M 1');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.artifacts/change-groups-${width}.png` });
  });
