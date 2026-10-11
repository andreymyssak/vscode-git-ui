import { expect, test } from '../fixtures/browser';

test('single click only selects; Enter opens a new window and the toolbar creates a worktree', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Worktrees', exact: true }).click();
  await page.evaluate(() => {
    const r = window.__requests.at(-1)!;

    window.__deliver({
      ...r,
      body: {
        kind: 'worktrees',
        worktrees: [
          {
            id: 'w',
            name: 'linked',
            rootUri: 'file:///example%20repo/linked',
            branch: 'topic',
            current: false,
            available: true,
          },
        ],
      },
    });
  });
  const row = page.getByRole('row', { name: /linked.*topic/ });

  await row.click();
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (r) => r.body.kind === 'open-worktree',
    ),
  ).toHaveLength(0);
  await row.press('Enter');
  expect((await page.evaluate(() => window.__requests)).at(-1)?.body).toEqual({
    kind: 'open-worktree',
    worktreeId: 'w',
    newWindow: true,
  });
  await page
    .getByRole('button', { name: 'Create Worktree', exact: true })
    .click();
  expect((await page.evaluate(() => window.__requests)).at(-1)?.body).toEqual({
    kind: 'action',
    action: { kind: 'create-worktree' },
  });
  await row.dblclick();
  expect((await page.evaluate(() => window.__requests)).at(-1)?.body).toEqual({
    kind: 'open-worktree',
    worktreeId: 'w',
    newWindow: true,
  });
});

for (const width of [620, 1400])
  test(`worktrees keep a left toolbar and aligned single-line columns at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 420 });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Worktrees', exact: true }).click();
    await page.evaluate(() => {
      const r = window.__requests.at(-1)!;

      window.__deliver({
        ...r,
        body: {
          kind: 'worktrees',
          worktrees: [
            {
              id: 'main',
              name: 'Current workspace',
              branch: 'main',
              rootUri: 'file:///example%20repo',
              current: true,
              main: true,
              available: true,
            },
            {
              id: 'linked',
              name: 'A long linked worktree name to keep on one line',
              branch: 'feature/long-branch-name-for-the-worktree',
              rootUri: 'file:///example%20repo/a%20linked%20folder',
              current: false,
              main: false,
              available: true,
            },
            {
              id: 'gone',
              name: 'Detached missing worktree',
              branch: null,
              rootUri: 'file:///example%20repo/missing',
              current: false,
              main: false,
              available: false,
            },
          ],
        },
      });
    });
    const toolbar = page.getByRole('toolbar', { name: 'Worktree actions' });
    const grid = page.getByRole('grid', { name: 'Existing worktrees' });
    const row = page.locator('[data-worktree="linked"]');
    const toolBounds = (await toolbar.boundingBox())!;
    const gridBounds = (await grid.boundingBox())!;

    expect(toolBounds.x + toolBounds.width).toBe(gridBounds.x);
    const heads = await grid.getByRole('columnheader').all();
    const cells = await row.getByRole('gridcell').all();

    for (let index = 0; index < heads.length; index++)
      expect((await cells[index]!.boundingBox())!.x).toBe(
        (await heads[index]!.boundingBox())!.x,
      );
    expect((await row.boundingBox())!.height).toBe(24);
    await row.click();
    await row.press('ArrowUp');
    const current = page.locator('[data-worktree="main"]');

    await expect(current).toBeFocused();
    await expect(current).toHaveAttribute('aria-selected', 'true');
    await current.press('ArrowDown');
    await expect(row).toBeFocused();
    await row.press('Shift+F10');
    await expect(row).toBeFocused();
    await row.focus();
    await row.press('ArrowDown');
    const missing = page.locator('[data-worktree="gone"]');

    await expect(missing).toBeFocused();
    await expect(
      toolbar.getByRole('button', { name: 'Create Worktree' }),
    ).toBeEnabled();
    await missing.press('Enter');
    expect(
      (await page.evaluate(() => window.__requests)).filter(
        ({ body }) => body.kind === 'open-worktree',
      ),
    ).toHaveLength(0);
    await row.click();
    await page.screenshot({
      path: `.artifacts/worktree-refinement-${width}.png`,
    });
    await toolbar.getByRole('button', { name: 'Refresh Worktrees' }).click();
    expect((await page.evaluate(() => window.__requests)).at(-1)?.body).toEqual(
      { kind: 'worktrees', retry: true },
    );
  });

test('worktree range menus retain targets and icon tooltips appear promptly with Escape dismissal', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Worktrees', exact: true }).click();
  await page.evaluate(() => {
    const r = window.__requests.at(-1)!;

    window.__deliver({
      ...r,
      body: {
        kind: 'worktrees',
        worktrees: ['main', 'alpha', 'beta'].map((id) => ({
          id,
          name: id,
          branch: id,
          rootUri: 'file:///example/' + id,
          current: id === 'main',
          main: id === 'main',
          available: true,
        })),
      },
    });
  });
  const refresh = page.getByRole('button', { name: 'Refresh Worktrees' });

  await refresh.hover();
  await expect(
    page.getByRole('tooltip', { name: 'Refresh Worktrees' }),
  ).toBeVisible({ timeout: 1000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const main = page.locator('[data-worktree="main"]');

  await main.click();
  await main.dblclick();
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (r) => r.body.kind === 'open-worktree',
    ),
  ).toHaveLength(0);
  const create = page.getByRole('button', { name: 'Create Worktree' });

  await create.hover();
  await expect(
    page.getByRole('tooltip', { name: 'Create Worktree' }),
  ).toBeVisible({ timeout: 1000 });
  const alpha = page.locator('[data-worktree="alpha"]');
  const beta = page.locator('[data-worktree="beta"]');

  await alpha.click();
  await beta.click({ modifiers: ['Shift'] });
  await beta.click({ button: 'right' });
  const context = JSON.parse((await beta.getAttribute('data-vscode-context'))!);

  expect(context.worktreeIds).toEqual(['alpha', 'beta']);
  expect(context.worktreeSelectionCount).toBe(2);
  expect(context.worktreeCanOpen).toBe(false);
  await beta.press('Delete');
  expect((await page.evaluate(() => window.__requests)).at(-1)?.body).toEqual({
    kind: 'action',
    action: { kind: 'delete-worktrees', worktreeIds: ['alpha', 'beta'] },
  });
  await alpha.click({ modifiers: ['ControlOrMeta'] });
  await expect(alpha).toHaveAttribute('aria-selected', 'false');
  await expect(beta).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => {
    const r = window.__requests
      .filter((r) => r.body.kind === 'worktrees')
      .at(-1)!;

    window.__deliver({
      ...r,
      body: {
        kind: 'worktrees',
        worktrees: [
          {
            id: 'main',
            name: 'main',
            branch: 'main',
            rootUri: 'file:///example/main',
            current: true,
            main: true,
            available: true,
          },
        ],
      },
    });
  });
  await expect(main).toHaveAttribute('tabindex', '0');
  await expect(create).toBeEnabled();
});
