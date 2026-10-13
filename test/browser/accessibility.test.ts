import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/browser';

const sha = (number: number) => number.toString(16).padStart(40, '0');

test('virtualized history exposes absolute row positions and an unknown total while paging', async ({
  page,
}) => {
  await page.goto('/');
  const history = page.locator('#history');

  await expect(history).toHaveAttribute('aria-rowcount', '-1');
  await expect(page.locator('[data-commit-row]').first()).toHaveAttribute(
    'aria-rowindex',
    '1',
  );
  await history.evaluate((node) => {
    node.scrollTop = 2400;
  });
  const row = page.locator('[data-commit-row][data-sha="' + sha(120) + '"]');

  await expect(row).toHaveAttribute('aria-rowindex', '120');
});

test('the editor Reduce Motion preference stops history loading animation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('[data-commit-row]').first()).toBeVisible();
  const animation = await page.evaluate(() => {
    document.body.classList.add('vscode-reduce-motion');
    const history = document.getElementById('history-pane');

    if (!history) throw new Error('History did not mount');
    history.setAttribute('aria-busy', 'true');

    return getComputedStyle(history, '::before').animationName;
  });

  expect(animation).toBe('none');
});

async function focusAtMountedBoundary(page: Page) {
  await page.goto('/');
  const history = page.locator('#history');
  const current = page.locator(
    '[data-commit-row][data-sha="' + sha(120) + '"]',
  );

  await history.evaluate((node) => {
    node.scrollTop = 2400;
  });
  await current.click();
  await expect(current).toBeFocused();
  const wheel = await history.evaluate(
    (node) => 100 * 22 - node.clientHeight - 1 - node.scrollTop,
  );

  await history.hover();
  await page.mouse.wheel(0, wheel);
  await expect(page.locator('[data-commit-row]').last()).toHaveAttribute(
    'data-sha',
    sha(120),
  );
  await expect(
    page.locator('[data-commit-row][data-sha="' + sha(121) + '"]'),
  ).toHaveCount(0);
  await expect(current).toBeFocused();
}

test('keyboard navigation keeps focus when wheel scrolling leaves the next row unmounted', async ({
  page,
}) => {
  await focusAtMountedBoundary(page);
  const next = page.locator('[data-commit-row][data-sha="' + sha(121) + '"]');

  await page.keyboard.press('ArrowDown');
  await expect(next).toHaveAttribute('aria-selected', 'true');
  await expect(next).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.locator('[data-commit-row][data-sha="' + sha(122) + '"]'),
  ).toBeFocused();
});

test('a pending keyboard focus request is cancelled when the user focuses search', async ({
  page,
}) => {
  await focusAtMountedBoundary(page);
  await page.evaluate(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    document.getElementById('search')!.focus();
  });
  await expect(
    page.locator('[data-commit-row][data-sha="' + sha(121) + '"]'),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('searchbox', { name: 'Text or hash' }),
  ).toBeFocused();
});

for (const scheme of ['light', 'dark', 'high-contrast'] as const)
  test(`keyboard history and resizing in ${scheme}`, async ({ page }) => {
    await page.goto('/');
    await page.emulateMedia({
      colorScheme: scheme === 'light' ? 'light' : 'dark',
      forcedColors: scheme === 'high-contrast' ? 'active' : 'none',
    });
    await page.locator('[data-commit-row]').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(
      page.locator('[data-commit-row][aria-selected="true"]'),
    ).toBeFocused();
    await page.keyboard.press('Shift+F10');
    await expect(
      page.locator('[data-commit-row][aria-selected="true"]'),
    ).toBeFocused();
    await page.getByRole('separator', { name: 'Resize details' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#log-view')).toHaveCSS(
      'grid-template-columns',
      /360px/,
    );
  });
