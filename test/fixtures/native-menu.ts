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
