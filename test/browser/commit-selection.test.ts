import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/browser';

const sha = (number: number) => number.toString(16).padStart(40, '0');
const row = (page: Page, number: number) =>
  page.locator(`[data-commit-row][data-sha="${sha(number)}"]`);
const selected = (page: Page) =>
  page
    .locator('[data-commit-row][aria-selected="true"]')
    .evaluateAll((rows) =>
      rows.map((node) => (node as HTMLElement).dataset.sha),
    );

test('Shift selects an inclusive range with a fixed anchor, active details and no browser text selection', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#history')).toHaveAttribute(
    'aria-multiselectable',
    'true',
  );
  await row(page, 2).click();
  await row(page, 4).click({ modifiers: ['Shift'] });
  expect(await selected(page)).toEqual([sha(2), sha(3), sha(4)]);
  await expect(row(page, 4)).toHaveAttribute('tabindex', '0');
  await expect(row(page, 2)).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('[data-commit-info]')).toContainText('Commit 4');
  await row(page, 1).click({ modifiers: ['Shift'] });
  expect(await selected(page)).toEqual([sha(1), sha(2)]);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await row(page, 5).click({ modifiers: ['Control'] });
  expect(await selected(page)).toEqual([sha(5)]);
});

test('Shift keyboard navigation grows, contracts and stops at a loaded boundary', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 2).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selected(page)).toEqual([sha(2), sha(3), sha(4)]);
  await expect(row(page, 4)).toBeFocused();
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selected(page)).toEqual([sha(2), sha(3)]);
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selected(page)).toEqual([sha(2)]);
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selected(page)).toEqual([sha(1), sha(2)]);
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selected(page)).toEqual([sha(1), sha(2)]);
  await expect(row(page, 1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  expect(await selected(page)).toEqual([sha(2)]);
});

test('right-click and keyboard menus preserve the full selected range before native dispatch', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 2).click();
  await row(page, 4).click({ modifiers: ['Shift'] });
  await page.evaluate(() =>
    window.addEventListener('contextmenu', (event) => {
      const target = (event.target as HTMLElement).closest('[data-commit-row]');

      Reflect.set(
        window,
        'rangeNativeContext',
        JSON.parse(target?.getAttribute('data-vscode-context') ?? '{}'),
      );
    }),
  );
  await row(page, 3).click({ button: 'right' });
  expect(await selected(page)).toEqual([sha(2), sha(3), sha(4)]);
  expect(
    await page.evaluate(() => Reflect.get(window, 'rangeNativeContext')),
  ).toMatchObject({
    commitSha: sha(3),
    commitShas: [sha(2), sha(3), sha(4)],
    commitSelectionCount: 3,
    commitCanEdit: false,
    commitCanCherryPick: true,
  });
  await row(page, 3).press('Shift+F10');
  expect(await selected(page)).toEqual([sha(2), sha(3), sha(4)]);
  await expect(row(page, 3)).toBeFocused();
  await row(page, 1).click({ button: 'right' });
  expect(await selected(page)).toEqual([sha(1)]);
  expect(
    await page.evaluate(() => Reflect.get(window, 'rangeNativeContext')),
  ).toMatchObject({
    commitShas: [sha(1)],
    commitSelectionCount: 1,
  });
});

test('Shift navigation keeps focus and range when the next virtual row is unmounted', async ({
  page,
}) => {
  await page.goto('/');
  const history = page.locator('#history');
  const current = row(page, 120);

  await history.evaluate((node) => {
    node.scrollTop = 2400;
  });
  await current.click();
  const wheel = await history.evaluate(
    (node) => 100 * 22 - node.clientHeight - 1 - node.scrollTop,
  );

  await history.hover();
  await page.mouse.wheel(0, wheel);
  await expect(page.locator('[data-commit-row]').last()).toHaveAttribute(
    'data-sha',
    sha(120),
  );
  await expect(row(page, 121)).toHaveCount(0);
  await expect(current).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(row(page, 121)).toBeFocused();
  expect(await selected(page)).toEqual([sha(120), sha(121)]);
  await page.keyboard.press('Shift+ArrowDown');
  await expect(row(page, 122)).toBeFocused();
  expect(await selected(page)).toEqual([sha(120), sha(121), sha(122)]);
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selected(page)).toEqual([sha(120), sha(121)]);
  await expect(row(page, 121)).toBeFocused();
});

test('history replacement reconciles a range to its valid active row', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 2).click();
  await row(page, 4).click({ modifiers: ['Shift'] });
  await page.evaluate(() => {
    const request = window.__requests.at(-1)!;

    window.__deliver({
      ...request,
      body: {
        kind: 'history',
        repository: {
          id: 'one',
          label: 'One',
          rootUri: 'file:///example',
          branch: 'main',
          headSha: '1'.padStart(40, '0'),
        },
        scope: { kind: 'head' },
        text: '',
        append: false,
        page: {
          commits: [2, 3, 4].map((number) => ({
            sha: number.toString(16).padStart(40, '0'),
            parents: [],
            message: 'Replaced ' + number,
            authorName: null,
            authorEmail: null,
            authorDate: null,
            commitDate: null,
          })),
          refs: [],
          nextCursor: null,
          scopeId: 'fixture',
        },
      },
    });
  });
  await expect(row(page, 4)).toHaveAttribute('aria-selected', 'true');
  expect(await selected(page)).toEqual([sha(4)]);
  await row(page, 2).click({ modifiers: ['Shift'] });
  expect(await selected(page)).toEqual([sha(2), sha(3), sha(4)]);
});

test('grid-focused Shift arrows resume the active range after its row scrolls out of the virtual window', async ({
  page,
}) => {
  await page.goto('/');
  const history = page.locator('#history');

  await row(page, 2).click();
  await history.evaluate((node) => {
    node.scrollTop = 22000;
  });
  await expect(row(page, 2)).toHaveCount(0);
  await history.focus();
  const before = await page.evaluate(
    () =>
      window.__requests.filter(
        (request) => request.body.kind === 'select-commits',
      ).length,
  );

  await page.keyboard.press('Shift+ArrowDown');
  await expect(row(page, 3)).toBeFocused();
  expect(await selected(page)).toEqual([sha(2), sha(3)]);
  await expect(page.locator('[data-commit-info]')).toContainText('Commit 3');
  expect(
    await page.evaluate(
      () =>
        window.__requests.filter(
          (request) => request.body.kind === 'select-commits',
        ).length,
    ),
  ).toBe(before + 1);
  expect(
    await page.evaluate(
      () =>
        window.__requests
          .filter((request) => request.body.kind === 'select-commits')
          .at(-1)?.body,
    ),
  ).toEqual({
    kind: 'select-commits',
    shas: [sha(2), sha(3)],
    activeSha: sha(3),
  });
  await page.keyboard.press('Shift+ArrowDown');
  await expect(row(page, 4)).toBeFocused();
  await history.evaluate((node) => {
    node.scrollTop = 22000;
  });
  await expect(row(page, 4)).toHaveCount(0);
  await history.focus();
  await page.keyboard.press('Shift+ArrowUp');
  await expect(row(page, 3)).toBeFocused();
  expect(await selected(page)).toEqual([sha(2), sha(3)]);
  await page.keyboard.press('Shift+ArrowUp');
  await expect(row(page, 2)).toBeFocused();
  expect(await selected(page)).toEqual([sha(2)]);
  await history.evaluate((node) => {
    node.scrollTop = 22000;
  });
  await expect(row(page, 2)).toHaveCount(0);
  await history.focus();
  await page.keyboard.press('ArrowUp');
  await expect(row(page, 1)).toBeFocused();
  expect(await selected(page)).toEqual([sha(1)]);
});

test('keyboard navigation restores the viewport before a pending scroll event updates the model', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 2).click();
  await page.locator('#history').evaluate((node) => {
    node.scrollTop = 22000;
    (node as HTMLElement).focus();
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
  });
  await expect(row(page, 1)).toBeFocused();
  expect(await selected(page)).toEqual([sha(1)]);
});

test('reference-control arrows do not navigate rows or the grid twice', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 2).click();
  const reference = row(page, 2).getByRole('group', {
    name: 'Local branch: topic',
  });

  await reference.focus();
  const before = await page.evaluate(
    () =>
      window.__requests.filter(
        (request) => request.body.kind === 'select-commits',
      ).length,
  );

  await page.keyboard.press('Shift+ArrowDown');
  await expect(reference).toBeFocused();
  expect(await selected(page)).toEqual([sha(2)]);
  expect(
    await page.evaluate(
      () =>
        window.__requests.filter(
          (request) => request.body.kind === 'select-commits',
        ).length,
    ),
  ).toBe(before);
});

test('grid arrows start at the first loaded row and an empty grid emits no selection', async ({
  page,
}) => {
  await page.goto('/');
  const history = page.locator('#history');

  await history.focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 1)).toBeFocused();
  expect(await selected(page)).toEqual([sha(1)]);
  await page.evaluate(() => {
    const request = window.__requests.at(-1)!;

    window.__deliver({
      ...request,
      body: {
        kind: 'history',
        append: false,
        scope: { kind: 'head' },
        text: '',
        repository: {
          id: 'one',
          label: 'One',
          rootUri: 'file:///example',
          branch: 'main',
          headSha: null,
        },
        page: { commits: [], refs: [], nextCursor: null, scopeId: 'empty' },
      },
    });
  });
  await expect(page.locator('[data-commit-row]')).toHaveCount(0);
  const before = await page.evaluate(
    () =>
      window.__requests.filter(
        (request) => request.body.kind === 'select-commits',
      ).length,
  );

  await history.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(history).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        window.__requests.filter(
          (request) => request.body.kind === 'select-commits',
        ).length,
    ),
  ).toBe(before);
});
