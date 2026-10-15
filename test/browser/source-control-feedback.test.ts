import { expect, test } from '@playwright/test';

import type { SourceControlResponse } from '../../src/shared/source-control';

test('Generate Commit Message hover stays readable inside a narrow Source Control view', async ({
  page,
}) => {
  await page.goto('/source-control.html');
  const generate = page.getByRole('button', {
    name: 'Generate Commit Message',
    exact: true,
  });

  for (const width of [320, 220, 160]) {
    await page.setViewportSize({ width, height: 620 });
    await page.mouse.move(0, 0);
    await generate.hover();
    const tooltip = page.getByRole('tooltip', {
      name: 'Generate a message for checked files',
      exact: true,
    });

    await expect(tooltip).toBeVisible();
    const bounds = (await tooltip.boundingBox())!;

    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
    expect(
      await tooltip.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
  }
});

test('Source Control keeps only the loading line visible without shifting content through the final refresh', async ({
  page,
}) => {
  await page.setViewportSize({ width: 220, height: 620 });
  await page.addInitScript(() => {
    window.addEventListener(
      'message',
      (event: MessageEvent<SourceControlResponse>) => {
        if (event.data.kind === 'source-control-state')
          Reflect.set(window, 'latestSourceControlState', event.data.state);
      },
    );
  });
  await page.goto('/source-control.html');
  const root = page.getByRole('region', { name: 'Source Control' });
  const status = page.getByRole('status', { name: 'Source Control activity' });
  const files = page.getByRole('tree', { name: 'Changes', exact: true });
  const message = page.getByRole('textbox', { name: 'Commit message' });

  await expect(root).toBeVisible();
  await expect(files).toBeVisible();
  const fileBounds = await files.boundingBox();
  const messageBounds = await message.boundingBox();

  for (const title of [
    'Loading last commit…',
    'Committing checked files…',
    'Refreshing changes…',
  ]) {
    await page.evaluate((title) => {
      const state: unknown = Reflect.get(window, 'latestSourceControlState');

      if (!state || typeof state !== 'object')
        throw new Error('Source Control has not loaded.');
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            kind: 'source-control-state',
            state: {
              ...state,
              busy: title !== 'Loading last commit…',
              activity: { repositoryId: 'repo', title },
            },
          },
        }),
      );
    }, title);
    await expect(status).toHaveText(title);
    await expect(root).toHaveAttribute('aria-busy', 'true');
    await expect(root.locator(':scope > [aria-hidden="true"]')).toHaveCSS(
      'height',
      '2px',
    );
    expect(await files.boundingBox()).toEqual(fileBounds);
    expect(await message.boundingBox()).toEqual(messageBounds);
  }

  await page.screenshot({
    path: '.artifacts/source-control-loading-line.png',
  });
  await page.evaluate(() => {
    const state: unknown = Reflect.get(window, 'latestSourceControlState');

    if (!state || typeof state !== 'object')
      throw new Error('Source Control has not loaded.');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          kind: 'source-control-state',
          state: { ...state, busy: false, activity: null },
        },
      }),
    );
  });
  await expect(status).toHaveCount(0);
  await expect(root).toHaveAttribute('aria-busy', 'false');
  await expect(root.locator(':scope > [aria-hidden="true"]')).toHaveCount(0);
  expect(await files.boundingBox()).toEqual(fileBounds);
  expect(await message.boundingBox()).toEqual(messageBounds);
});
