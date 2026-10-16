import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

async function focusNativeMenuItem(item: Locator) {
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  const menu = item.locator('xpath=ancestor::*[@role="menu"][1]');

  // DOM focus alone does not update VS Code's ActionBar selection. Navigate
  // through its keyboard handler before the single mutation activation.
  await menu.focus();
  await expect
    .poll(() => item.page().evaluate(() => document.hasFocus()))
    .toBe(true);
  await item.page().keyboard.press('Home');
  const count = await menu.getByRole('menuitem').count();

  for (let index = 0; index < count; index++) {
    if (await item.evaluate((node) => node.matches(':focus'))) break;
    await item.page().keyboard.press('ArrowDown');
  }

  await expect(item).toBeFocused();
}

export async function openNativeSubmenu(item: Locator) {
  await focusNativeMenuItem(item);
  await item.page().keyboard.press('ArrowRight');
}

export async function activateNativeMenu(item: Locator) {
  await focusNativeMenuItem(item);
  await item.page().keyboard.press('Enter');
  // The menu restores focus while closing. Let it finish before interacting
  // with a picker opened by the action, so it cannot steal picker focus.
  await expect(item).toBeHidden();
}

export async function acceptNativeQuickPick({
  widget,
  input,
  label,
}: {
  widget: Locator;
  input: Locator;
  label: string | RegExp;
}) {
  // Accept the native active item after asynchronous filtering has settled.
  await expect(
    widget
      .locator('.monaco-list-row.focused')
      .getByText(label, { exact: true }),
  ).toBeVisible();
  await expect(input).toBeFocused();
  await expect
    .poll(() => input.page().evaluate(() => document.hasFocus()))
    .toBe(true);
  await input.press('Enter');
}

export async function activateNativeButton(button: Locator) {
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.focus();
  await expect(button).toBeFocused();
  await expect
    .poll(() => button.page().evaluate(() => document.hasFocus()))
    .toBe(true);
  await button.press('Enter');
}

/** Capture the same lazy row context that the workbench reads, without invoking an action. */
export async function readNativeMenuContext(target: Locator): Promise<unknown> {
  const page = target.page();

  // A pending editor preview can dismiss a newly opened popup. Retry only
  // opening the menu; the caller invokes its protected action exactly once.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await target.focus();
    await expect(target).toBeFocused();
    await expect
      .poll(() => target.evaluate(() => document.hasFocus()))
      .toBe(true);
    await target.press('Shift+F10');
    await expect(
      page.locator('.monaco-menu').getByRole('menuitem').first(),
    ).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10000 });

  try {
    const encoded = await target.getAttribute('data-vscode-context');

    if (!encoded)
      throw new Error('Opening the native menu must prepare the row context.');
    const context: unknown = JSON.parse(encoded);

    return context;
  } finally {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect
      .poll(() =>
        target.evaluate(() =>
          document.body.classList.contains('vscode-context-menu-visible'),
        ),
      )
      .toBe(false);
  }
}
