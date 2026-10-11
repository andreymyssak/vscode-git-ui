import { expect, test } from '@playwright/test';

test('commit message tools stay above the message and fit a narrow sidebar', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  const toolbar = page.getByRole('toolbar', { name: 'Commit message actions' });
  const message = page.getByRole('textbox', { name: 'Commit message' });

  await expect(
    toolbar.getByRole('checkbox', { name: 'Amend last commit' }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole('button', { name: 'Generate Commit Message' }),
  ).toBeVisible();
  const checkbox = toolbar.getByRole('checkbox', {
    name: 'Amend last commit',
  });
  const label = toolbar.getByText('Amend last commit', { exact: true });
  const box = (await checkbox.boundingBox())!;
  const text = (await label.boundingBox())!;

  expect(text.x - box.x - box.width).toBeCloseTo(6, 0);
  for (const width of [320, 220]) {
    await page.setViewportSize({ width, height: 620 });
    const tools = (await toolbar.boundingBox())!;
    const field = (await message.boundingBox())!;

    expect(tools.y + tools.height).toBeLessThanOrEqual(field.y);
    expect(
      await toolbar.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }

  await page.setViewportSize({ width: 320, height: 620 });
  await page.screenshot({
    path: '.artifacts/commit-message-toolbar-browser.png',
  });
});

test('checked file statistics follow inclusion and wrap in a narrow commit toolbar', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  const toolbar = page.getByRole('toolbar', { name: 'Commit message actions' });
  const summary = toolbar.getByRole('status', {
    name: 'Checked files summary',
  });
  const tree = page.getByRole('tree', { name: 'Changes' });
  const all = tree
    .getByRole('treeitem', { name: 'Changes', exact: true })
    .getByRole('checkbox', { name: 'Include all changes', exact: true });

  await expect(summary).toHaveCount(0);
  await all.click();
  await expect(all).toBeChecked();
  await expect(summary.getByText('M 1', { exact: true })).toBeVisible();
  await expect(summary.getByText('U 1', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      '--vscode-gitDecoration-modifiedResourceForeground',
      '#4090d0',
    );
    document.documentElement.style.setProperty(
      '--vscode-gitDecoration-untrackedResourceForeground',
      '#309050',
    );
  });
  await expect(summary.getByText('M 1', { exact: true })).toHaveCSS(
    'color',
    'rgb(64, 144, 208)',
  );
  await expect(summary.getByText('U 1', { exact: true })).toHaveCSS(
    'color',
    'rgb(48, 144, 80)',
  );
  for (const width of [500, 320, 220]) {
    await page.setViewportSize({ width, height: 620 });
    await expect(summary).toBeVisible();
    const tools = (await toolbar.boundingBox())!;
    const field = (await page
      .getByRole('textbox', { name: 'Commit message' })
      .boundingBox())!;

    expect(tools.y + tools.height).toBeLessThanOrEqual(field.y);
    expect(
      await toolbar.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }

  await page.setViewportSize({ width: 500, height: 620 });
  await page.screenshot({ path: '.artifacts/checked-files-summary.png' });
  await summary.getByText('M 1', { exact: true }).hover();
  await expect(
    page.getByRole('tooltip', { name: '1 modified file checked', exact: true }),
  ).toBeVisible({ timeout: 1500 });
  await all.click();
  await expect(all).not.toBeChecked();
  await expect(summary).toHaveCount(0);
});

test('folder counts stay beside their names with a muted status dot at the right', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  const folder = page.getByRole('treeitem', { name: 'src', exact: true });
  const name = folder.getByText('src', { exact: true });
  const count = folder.getByText('2 files', { exact: true });
  const dot = folder.locator('[data-folder-status]');

  for (const width of [320, 220]) {
    await page.setViewportSize({ width, height: 620 });
    const nameBounds = (await name.boundingBox())!;
    const countBounds = (await count.boundingBox())!;

    expect(countBounds.x - nameBounds.x - nameBounds.width).toBe(6);
    await expect(dot).toBeVisible();
    const dotBounds = (await dot.boundingBox())!;
    const rowBounds = (await folder.boundingBox())!;

    expect(dotBounds.x).toBeGreaterThan(countBounds.x + countBounds.width);
    expect(rowBounds.x + rowBounds.width - dotBounds.x - dotBounds.width).toBe(
      12,
    );
    expect(
      await folder.evaluate((row) => row.scrollWidth <= row.clientWidth),
    ).toBe(true);
  }

  expect(
    await dot.locator('.codicon').evaluate((element) => {
      const style = getComputedStyle(element);

      return { size: style.fontSize, opacity: style.opacity };
    }),
  ).toEqual({ size: '11px', opacity: '0.4' });
  await page.setViewportSize({ width: 320, height: 620 });
  await page.screenshot({ path: '.artifacts/folder-count-layout.png' });
});

test('highlighted ranges target context actions independently of inclusion in grouped and flat lists', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  const tree = page.getByRole('tree', { name: 'Changes' });
  const first = tree.getByRole('treeitem', {
    name: 'src/nested/example.ts',
    exact: true,
  });
  const last = tree.getByRole('treeitem', { name: 'src/new.ts', exact: true });
  const source = tree.getByRole('treeitem', { name: 'src', exact: true });
  const context = async () =>
    JSON.parse((await first.getAttribute('data-vscode-context')) ?? '{}');

  await first.getByRole('checkbox').click();
  await expect(first.getByRole('checkbox')).toBeChecked();
  await first.click();
  await last.click({ modifiers: ['Shift'] });
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await first.click({ button: 'right' });
  expect(await context()).toMatchObject({
    paths: ['src/nested/example.ts', 'src/new.ts'],
  });
  await expect(first.getByRole('checkbox')).toBeChecked();
  await expect(last.getByRole('checkbox')).not.toBeChecked();
  await last.click({ modifiers: ['ControlOrMeta'] });
  await expect(last).toHaveAttribute('aria-selected', 'false');
  await source.click({ button: 'right' });
  expect(
    JSON.parse((await source.getAttribute('data-vscode-context')) ?? '{}'),
  ).toMatchObject({
    paths: ['src/nested/example.ts', 'src/new.ts'],
    copyPaths: ['src'],
  });
  await page.getByRole('button', { name: 'View Options', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Group by Directory', exact: true })
    .uncheck();
  await page.keyboard.press('Escape');
  await first.click();
  await first.press('Shift+ArrowDown');
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await first.press('Shift+F10');
  expect(await context()).toMatchObject({
    paths: ['src/nested/example.ts', 'src/new.ts'],
  });
  await expect(first.getByRole('checkbox')).toBeChecked();
  await expect(last.getByRole('checkbox')).not.toBeChecked();
});

test('tree hovers match Source Control paths, status and configured delay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 620 });
  await page.goto('/source-control.html');
  await page.clock.install();
  const tree = page.getByRole('tree', { name: 'Changes' });
  const source = tree.getByRole('treeitem', { name: 'src', exact: true });
  const sourceLabel = source.getByText('src', { exact: true }).locator('..');
  const folder = tree.getByRole('treeitem', {
    name: 'src/nested',
    exact: true,
  });
  const file = tree.getByRole('treeitem', {
    name: 'src/nested/example.ts',
    exact: true,
  });
  const tooltip = page.getByRole('tooltip');

  await sourceLabel.hover();
  await page.clock.runFor(600);
  await expect(tooltip).toHaveCount(0);
  await page.clock.runFor(150);
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText(
    '~/projects/example/src • Contains emphasized items',
  );
  await folder.getByText('nested', { exact: true }).hover();
  await page.clock.runFor(400);
  await expect(tooltip).toHaveCount(0);
  await page.clock.runFor(350);
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText(
    '~/projects/example/src/nested • Contains emphasized items',
  );
  expect(await folder.evaluate((row) => row.closest('[title]'))).toBeNull();
  await file.getByText('example.ts', { exact: true }).hover();
  await page.clock.runFor(750);
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText(
    '~/projects/example/src/nested/example.ts • Modified',
  );
  expect(
    await tooltip.evaluate((element) => {
      const style = getComputedStyle(element);

      return {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        padding: style.padding,
        borderRadius: style.borderRadius,
      };
    }),
  ).toEqual({
    fontSize: '12px',
    lineHeight: '19px',
    padding: '2px 8px',
    borderRadius: '5px',
  });
  await page.screenshot({ path: '.artifacts/file-hover-dark.png' });
  expect(await tree.locator('[title]').count()).toBe(0);
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await page.getByRole('tab', { name: 'Stashes', exact: true }).hover();
  await expect(tooltip).toHaveCount(0);
  await page.getByRole('tab', { name: 'Stashes', exact: true }).click();
  await page.getByText('Example stash', { exact: true }).hover();
  await page.clock.runFor(750);
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toContainText('Example stash');
  await expect(tooltip).toContainText('stash@{0}');
});

test('only Discard Changes appears on file hover and its click does not open or check the file', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  const file = page.getByRole('treeitem', {
    name: 'src/nested/example.ts',
    exact: true,
  });
  const discard = file.getByRole('button', {
    name: 'Discard Changes',
    exact: true,
  });

  await expect(discard).toBeHidden();
  await file.hover();
  await expect(discard).toBeVisible();
  await discard.click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'sourceControlRequests')),
  ).toEqual(
    expect.arrayContaining([
      {
        kind: 'discard-working',
        repositoryId: 'repo',
        path: 'src/nested/example.ts',
      },
    ]),
  );
  await expect(file.getByRole('checkbox')).not.toBeChecked();
  expect(
    await page.evaluate(() => Reflect.get(window, 'sourceControlRequests')),
  ).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'open-working' })]),
  );
  await file.focus();
  await expect(discard).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(discard).toBeFocused();
  await page.keyboard.press('Enter');
});

test('Changes toolbar groups files and reveals the opened file without changing inclusion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 620 });
  await page.goto('/source-control.html');
  const root = page.locator('[data-source-control]');
  const file = root.getByRole('treeitem', {
    name: 'src/nested/example.ts',
    exact: true,
  });
  const changedRoot = root.getByRole('treeitem', {
    name: 'Changes',
    exact: true,
  });

  await expect(changedRoot).toHaveAttribute('aria-level', '1');
  await expect(file).toHaveAttribute('aria-level', '4');
  expect(
    await file
      .locator('[data-file-icon] .codicon')
      .evaluate((icon) => getComputedStyle(icon).fontSize),
  ).toBe('16px');
  expect(await file.evaluate((row) => row.getBoundingClientRect().height)).toBe(
    22,
  );
  const icon = (await file.locator('[data-file-icon]').boundingBox())!;
  const name = (await file.locator(':scope > span').nth(2).boundingBox())!;

  expect(icon.width).toBe(16);
  expect(name.x - icon.x - icon.width).toBe(6);
  const guide = root.locator('[role="group"]').first();

  expect(
    await guide.evaluate(
      (group) => getComputedStyle(group, '::before').borderLeftWidth,
    ),
  ).toBe('1px');
  await root.getByRole('button', { name: 'Collapse All', exact: true }).click();
  await expect(file).not.toBeVisible();
  await root
    .getByRole('button', {
      name: 'Select Opened File in Changes View',
      exact: true,
    })
    .click();
  await expect(file).toBeFocused();
  await expect(file.getByRole('checkbox')).not.toBeChecked();
  await root.getByRole('button', { name: 'View Options', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Changes view options' });

  await expect(menu).toBeVisible();
  await menu
    .getByRole('checkbox', { name: 'Group by Directory', exact: true })
    .uncheck();
  await expect(file).toHaveAttribute('aria-level', '2');
  await page.keyboard.press('Escape');
  await expect(
    root.getByRole('button', { name: 'View Options', exact: true }),
  ).toBeFocused();
  await root.getByRole('button', { name: 'View Options', exact: true }).click();
  await menu
    .getByRole('checkbox', { name: 'Group by Directory', exact: true })
    .check();
  await page.keyboard.press('Escape');
  await changedRoot.click();
  await expect(file.getByRole('checkbox')).toBeChecked();
  await root
    .getByRole('button', { name: 'Stash Silently', exact: true })
    .click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'sourceControlRequests')),
  ).toEqual(
    expect.arrayContaining([{ kind: 'stash-silently', repositoryId: 'repo' }]),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({ path: '.artifacts/changes-toolbar-dark.png' });
});

test('file-only icon themes keep checkboxes aligned with folder depth', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          requestId: 'icons',
          repositoryId: '',
          generation: 0,
          body: {
            kind: 'file-icon-theme',
            stylesheet: null,
            theme: {
              definitions: {
                file: {
                  uri: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" />',
                },
              },
              associations: {
                file: 'file',
                fileNames: {},
                fileExtensions: {},
                languageIds: {},
                folderNames: {},
                folderNamesExpanded: {},
              },
              languages: { fileNames: {}, extensions: {} },
            },
          },
        },
      }),
    );
  });
  const folder = page.getByRole('treeitem', {
    name: 'src/nested',
    exact: true,
  });
  const file = page.getByRole('treeitem', {
    name: 'src/nested/example.ts',
    exact: true,
  });

  await expect(folder.locator('[data-file-icon]')).toHaveCount(0);
  await expect(file.locator('[data-file-icon]')).toHaveCount(1);
  const parentCheck = (await folder.getByRole('checkbox').boundingBox())!;
  const childCheck = (await file.getByRole('checkbox').boundingBox())!;

  expect(childCheck.x - parentCheck.x).toBe(8);
});

test('a working-file click opens its diff while its checkbox only changes inclusion', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  const file = page.locator(
    '[data-source-control] [data-path="src/nested/example.ts"]',
  );

  await file.getByRole('checkbox').click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'sourceControlRequests')),
  ).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'open-working' })]),
  );
  await file.click();
  const requests: unknown = await page.evaluate(() =>
    Reflect.get(window, 'sourceControlRequests'),
  );

  expect(requests).toEqual(
    expect.arrayContaining([
      {
        kind: 'open-working',
        repositoryId: 'repo',
        path: 'src/nested/example.ts',
        index: false,
      },
    ]),
  );
  expect(
    Array.isArray(requests)
      ? requests.filter(
          (request: unknown) =>
            typeof request === 'object' &&
            request !== null &&
            'kind' in request &&
            request.kind === 'open-working',
        ).length
      : 0,
  ).toBe(1);
});

test('Commit and Stash controls fit a narrow themed sidebar and keep an editable draft', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 620 });
  await page.goto('/source-control.html');
  const root = page.locator('[data-source-control]');

  await expect(root).toBeVisible();
  await expect(
    root.locator('[data-path="src/nested/example.ts"]'),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await root
    .locator('[data-path="src/nested/example.ts"]')
    .getByRole('checkbox')
    .click();
  await root
    .getByRole('textbox', { name: 'Commit message' })
    .fill('My draft\n\nA body');
  await root.getByRole('tab', { name: 'Stashes', exact: true }).click();
  await root.getByRole('tab', { name: 'Commit', exact: true }).click();
  await expect(
    root.getByRole('textbox', { name: 'Commit message' }),
  ).toHaveValue('My draft\n\nA body');
  await root
    .getByRole('button', { name: 'Generate Commit Message', exact: true })
    .click();
  await expect(
    root.getByRole('textbox', { name: 'Commit message' }),
  ).toHaveValue('Update example behavior');
  const requests: unknown = await page.evaluate(() =>
    Reflect.get(window, 'sourceControlRequests'),
  );

  expect(requests).toEqual(
    expect.arrayContaining([{ kind: 'generate', repositoryId: 'repo' }]),
  );
  expect(requests).not.toEqual(
    expect.arrayContaining([{ kind: 'commit', repositoryId: 'repo' }]),
  );
  await root.getByRole('button', { name: 'Commit', exact: true }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'sourceControlRequests')),
  ).toEqual(expect.arrayContaining([{ kind: 'commit', repositoryId: 'repo' }]));
});

test('file open and selected restore requests identify the saved snapshot', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  const root = page.locator('[data-source-control]');

  await root.getByRole('tab', { name: 'Stashes', exact: true }).click();
  await root
    .locator('[data-stash]')
    .getByRole('button', { name: /Example stash/ })
    .click();
  const file = root.locator(
    '[data-path="src/nested/example.ts"][data-snapshot="working"]',
  );

  await expect(file).toBeVisible();
  await file.getByRole('checkbox').click();
  await file.click();
  await root.getByRole('button', { name: 'Apply Stash', exact: true }).click();
  const requests: unknown = await page.evaluate(() =>
    Reflect.get(window, 'sourceControlRequests'),
  );

  expect(requests).toEqual(
    expect.arrayContaining([
      {
        kind: 'open-stash-file',
        repositoryId: 'repo',
        sha: 'a'.repeat(40),
        file: { path: 'src/nested/example.ts', snapshot: 'working' },
      },
      {
        kind: 'restore-stash-files',
        repositoryId: 'repo',
        sha: 'a'.repeat(40),
        files: [{ path: 'src/nested/example.ts', snapshot: 'working' }],
      },
    ]),
  );
});

test('Stash toolbar groups and expands saved files and restores only an explicit selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 620 });
  await page.goto('/source-control.html');
  const root = page.locator('[data-source-control]');

  await root.getByRole('tab', { name: 'Stashes', exact: true }).click();
  const toolbar = root.getByRole('toolbar', { name: 'Stashes actions' });

  await toolbar.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'sourceControlRequests')),
  ).toEqual(expect.arrayContaining([{ kind: 'refresh' }]));
  const applyStash = toolbar.getByRole('button', { name: 'Apply Stash' });
  const expand = toolbar.getByRole('button', { name: 'Expand All' });
  const file = root.getByRole('treeitem', {
    name: 'src/nested/example.ts',
    exact: true,
  });

  await expect(applyStash).toBeDisabled();
  await expand.click();
  await expect(file).toBeVisible();
  await root.getByRole('treeitem', { name: 'src/nested', exact: true }).click();
  await expect(file).not.toBeVisible();
  await expand.click();
  await expect(file).toBeVisible();
  await file.getByRole('checkbox').check();
  await expect(applyStash).toBeEnabled();
  await file.getByRole('checkbox').uncheck();
  await expect(applyStash).toBeDisabled();
  await toolbar.getByRole('button', { name: 'View Options' }).click();
  const options = page.getByRole('dialog', { name: 'Stashes view options' });

  await options.getByRole('checkbox', { name: 'Group by Directory' }).uncheck();
  await expect(file).toHaveAttribute('aria-level', '1');
  await page.keyboard.press('Escape');
  await toolbar.getByRole('button', { name: 'Collapse All' }).click();
  await expect(file).not.toBeVisible();
  await expand.click();
  await expect(file).toBeVisible();
  await root.getByRole('button', { name: 'Collapse Example stash' }).click();
  await expect(applyStash).toBeEnabled();
  await applyStash.click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'sourceControlRequests')),
  ).toEqual(
    expect.arrayContaining([
      { kind: 'restore-stash', repositoryId: 'repo', sha: 'a'.repeat(40) },
    ]),
  );
  await expand.hover();
  await expect(
    page.getByRole('tooltip', { name: 'Expand All', exact: true }),
  ).toBeVisible({ timeout: 1000 });
  await expand.click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({ path: '.artifacts/stash-toolbar-dark.png' });
});
