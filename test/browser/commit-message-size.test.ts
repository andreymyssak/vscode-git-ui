import { expect, test } from '@playwright/test';

test('the top divider resizes the commit section and its editor together', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 620 });
  await page.goto('/source-control.html');
  const divider = page.getByRole('separator', {
    name: 'Resize commit message',
  });
  const message = page.getByRole('textbox', { name: 'Commit message' });
  const toolbar = page.getByRole('toolbar', { name: 'Commit message actions' });
  const commit = page.getByRole('button', {
    name: /^Commit(?: to |$)/,
    exact: true,
  });

  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(message).toHaveCSS('resize', 'none');
  const before = (await message.boundingBox())!;
  const handle = (await divider.boundingBox())!;

  expect(handle.y + handle.height).toBeLessThanOrEqual(
    (await toolbar.boundingBox())!.y,
  );
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 78);
  await page.mouse.up();
  await expect
    .poll(async () => (await message.boundingBox())!.height)
    .toBeCloseTo(before.height + 80, 0);
  await divider.focus();
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => (await message.boundingBox())!.height)
    .toBeCloseTo(before.height + 70, 0);
  const enlarged = (await message.boundingBox())!;

  await message.fill('A subject\n\n' + 'Long commit body\n'.repeat(40));
  expect((await message.boundingBox())!.height).toBeCloseTo(enlarged.height, 0);
  expect(
    await message.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  const button = (await commit.boundingBox())!;

  expect(button.y).toBeGreaterThanOrEqual(enlarged.y + enlarged.height);
  expect(button.y + button.height).toBeLessThanOrEqual(620);
  await page.screenshot({ path: '.artifacts/commit-message-resize.png' });
});

test('a shorter sidebar preserves the preferred commit height and cancelled drags stop resizing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 220, height: 620 });
  await page.goto('/source-control.html');
  const divider = page.getByRole('separator', {
    name: 'Resize commit message',
  });
  const message = page.getByRole('textbox', { name: 'Commit message' });

  await divider.focus();
  for (let index = 0; index < 15; index++) await page.keyboard.press('ArrowUp');
  const preferred = await divider.getAttribute('aria-valuenow');

  await page.setViewportSize({ width: 220, height: 280 });
  await expect(message).toBeVisible();
  const button = page.getByRole('button', {
    name: /^Commit(?: to |$)/,
    exact: true,
  });

  await expect
    .poll(async () => {
      const bounds = (await button.boundingBox())!;

      return bounds.y + bounds.height;
    })
    .toBeLessThanOrEqual(280);
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBeLessThan(
    Number(preferred),
  );
  await page.setViewportSize({ width: 220, height: 620 });
  await expect(divider).toHaveAttribute('aria-valuenow', preferred!);
  await divider.dispatchEvent('pointerdown', {
    button: 0,
    isPrimary: true,
    pointerId: 7,
    clientY: 400,
  });
  await divider.dispatchEvent('pointermove', { pointerId: 7, clientY: 380 });
  await divider.dispatchEvent('pointercancel', { pointerId: 7 });
  const stopped = await divider.getAttribute('aria-valuenow');

  await divider.dispatchEvent('pointermove', { pointerId: 7, clientY: 250 });
  await expect(divider).toHaveAttribute('aria-valuenow', stopped!);
  await page.getByRole('tab', { name: 'Stashes', exact: true }).click();
  await expect(divider).toHaveCount(0);
  await page.getByRole('tab', { name: 'Commit', exact: true }).click();
  await expect(divider).toHaveAttribute('aria-valuenow', stopped!);
});
