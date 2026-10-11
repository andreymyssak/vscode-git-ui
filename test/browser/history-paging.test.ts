import type { RestorableView } from '../../src/shared/model';
import { expect, test } from '../fixtures/browser';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-history-content]')).toHaveCSS(
    'height',
    '4400px',
  );
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
});

test('near-end scrolling requests each cursor once while a page is pending', async ({
  page,
}) => {
  await page.evaluate(() => {
    const deliver = window.__deliver;

    window.__deliver = (message) => {
      if (message.body.kind === 'history' && message.body.append) {
        Reflect.set(window, 'pendingHistoryPage', message);
        window.addEventListener(
          'finish-history-page',
          () => {
            window.__deliver = deliver;
            deliver(message);
          },
          { once: true },
        );
      } else deliver(message);
    };
  });
  const history = page.locator('#history');

  for (let i = 0; i < 3; i++)
    await history.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__requests)).filter(
          (request) =>
            request.body.kind === 'history' && request.body.cursor === '200',
        ).length,
    )
    .toBe(1);
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event('finish-history-page')),
  );
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator('[data-history-content]')).toHaveCSS(
    'height',
    '8800px',
  );
  await history.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__requests)).filter(
          (request) =>
            request.body.kind === 'history' && request.body.cursor === '400',
        ).length,
    )
    .toBe(1);
});

test('a failed automatic page is not retried by incidental scrolling', async ({
  page,
}) => {
  await page.evaluate(() => {
    const deliver = window.__deliver;

    window.__deliver = (message) =>
      message.body.kind === 'history' && message.body.append
        ? deliver({
            ...message,
            body: { kind: 'error', message: 'Page failed' },
          })
        : deliver(message);
  });
  const history = page.locator('#history');

  await history.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__requests)).filter(
          (request) =>
            request.body.kind === 'history' && request.body.cursor === '200',
        ).length,
    )
    .toBe(1);
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.getByText('Page failed')).toHaveCount(0);
  await expect(page.locator('#status')).toBeHidden();
  for (const delta of [-22, 22]) {
    const anchor = await history.evaluate((node, delta) => {
      node.scrollTop += delta;
      node.dispatchEvent(new Event('scroll'));

      return {
        sha: (Math.floor(node.scrollTop / 22) + 1)
          .toString(16)
          .padStart(40, '0'),
        offset: node.scrollTop % 22,
      };
    }, delta);

    await expect
      .poll(() =>
        page.evaluate(
          () => (window.__savedWrites.at(-1) as RestorableView).anchor,
        ),
      )
      .toEqual(anchor);
  }

  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (request) =>
        request.body.kind === 'history' && request.body.cursor === '200',
    ),
  ).toHaveLength(1);
});
