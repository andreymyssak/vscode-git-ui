import { expect, test } from '../fixtures/browser';

for (const width of [620, 1280])
  for (const outcome of ['success', 'empty', 'error'] as const)
    test(`${outcome} branch loading keeps pane and control positions stable at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 280 });
      await page.goto('/?multiple');
      const selectors = [
        '#branch-pane',
        '#history-pane',
        '#details',
        '#left-resizer',
        '#right-resizer',
        '#search',
        '#author-filter',
        '#date-filter',
        '#repository',
        '#refresh',
        '#fetch',
      ];
      const bounds = async () =>
        Promise.all(
          selectors.map((selector) => page.locator(selector).boundingBox()),
        );
      const before = await bounds();

      await page.evaluate((outcome) => {
        const deliver = window.__deliver;

        window.__deliver = (message) => {
          if (message.body.kind === 'history') {
            const response =
              outcome === 'empty'
                ? {
                    ...message,
                    body: {
                      ...message.body,
                      page: {
                        ...message.body.page,
                        commits: [],
                        nextCursor: null,
                      },
                    },
                  }
                : outcome === 'error'
                  ? {
                      ...message,
                      body: {
                        kind: 'error' as const,
                        message: 'Branch history failed.',
                      },
                    }
                  : message;

            window.addEventListener(
              'finish-history',
              () => {
                window.__deliver = deliver;
                deliver(response);
              },
              { once: true },
            );
          } else deliver(message);
        };
      }, outcome);

      await page
        .getByRole('treeitem', { name: 'topic', exact: true })
        .dblclick();
      await expect(page.getByRole('status')).toHaveText('Loading history…');
      expect(await bounds()).toEqual(before);
      await expect(page.locator('#history-pane')).toHaveAttribute(
        'aria-busy',
        'true',
      );

      await page.evaluate(() =>
        window.dispatchEvent(new Event('finish-history')),
      );
      await expect(page.locator('#history-pane')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      expect(await bounds()).toEqual(before);
      await expect(page.locator('#scope')).toHaveText('topic');
      if (outcome === 'success') {
        await expect(page.locator('[data-commit-row]').first()).toBeVisible();
        await expect(page.getByRole('status')).toBeHidden();
      } else if (outcome === 'empty') {
        await expect(page.locator('[data-commit-row]')).toHaveCount(0);
        const message = 'No commits in these results.';

        await expect(page.getByRole('status')).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole('status')).toHaveText(message);
        await expect(page.getByRole('status')).toHaveAttribute(
          'title',
          message,
        );
      } else {
        await expect(page.locator('[data-commit-row]')).toHaveCount(0);
        await expect(page.getByText('Branch history failed.')).toHaveCount(0);
        await expect(page.locator('#status')).toBeHidden();
      }

      await page
        .getByRole('treeitem', { name: 'main (Current branch)', exact: true })
        .dblclick();
      await expect(page.locator('[data-commit-row]').first()).toBeVisible();
      expect(await bounds()).toEqual(before);
      await expect(page.getByRole('status')).toBeHidden();
    });
