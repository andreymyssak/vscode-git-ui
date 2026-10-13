import { expect, test } from '../fixtures/browser';

test('a failed bootstrap request reports its network error and permits a later navigation', async ({
  page,
}) => {
  await page.route('**/fake-vscode-host.js', (route) => route.abort('failed'));
  await expect(page.goto('/')).rejects.toThrow(
    /fake-vscode-host\.js: net::ERR_FAILED/,
  );
  await page.unroute('**/fake-vscode-host.js');
  await page.goto('/');
  await expect(page.locator('[data-commit-row]').first()).toBeVisible();
});
