import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

export async function activateNativeMenu(item: Locator) {
  await expect(item).toBeVisible();
  await expect(item).toBeEnabled();
  // Hover selects the native ActionBar item before keyboard activation.
  await item.hover();
  await item.focus();
  await expect(item).toBeFocused();
  await expect
    .poll(() => item.page().evaluate(() => document.hasFocus()))
    .toBe(true);
  await item.press('Enter');
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
