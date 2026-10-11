import { expect, test } from '@playwright/test';

import type { SourceControlState } from '../../src/shared/source-control';

test.use({ locale: 'en-GB', timezoneId: 'UTC' });

const name =
  'fix: show one empty state in Git UI Changes Hide the Changes tree when no working files remain and keep the commit message editor available';
const sha = 'a'.repeat(40);
const state: SourceControlState = {
  hoverDelay: 700,
  repositoryId: 'repo',
  tab: 'stash',
  busy: false,
  generating: false,
  reveal: null,
  repositories: [
    {
      pathLabel: { root: '/example', separator: '/' },
      info: {
        id: 'repo',
        label: 'Example repository',
        rootUri: 'file:///example',
        headSha: sha,
        branch: 'main',
      },
      checked: [],
      draft: '',
      draftEditId: null,
      commitMode: { kind: 'new' },
      changes: { kind: 'ready', items: [] },
      stashes: {
        kind: 'ready',
        items: [
          {
            sha,
            viewId: sha,
            base: sha,
            date: '2026-10-11T09:05:00Z',
            selector: 'stash@{0}',
            message: name,
            files: {
              kind: 'ready',
              items: Array.from({ length: 80 }, (_, index) => ({
                path: `src/file-${index}.ts`,
                originalPath: `src/file-${index}.ts`,
                status: 'M',
                snapshot: 'working',
                oldRef: sha,
                newRef: sha,
                deleted: false,
              })),
            },
          },
        ],
      },
    },
  ],
};

for (const width of [220, 320, 640])
  test(`long stash names leave the full date visible and the header stays pinned at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 620 });
    await page.goto('/source-control.html');
    const root = page.locator('[data-source-control]');

    await root.getByRole('tab', { name: 'Stashes', exact: true }).click();
    await page.evaluate((next) => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { kind: 'source-control-state', state: next },
        }),
      );
    }, state);
    const stash = root.getByRole('region', {
      name,
      exact: true,
    });
    const header = stash.getByRole('button', { name: `Expand ${name}` });
    const title = header.getByText(name, { exact: true });
    const number = stash.getByText('stash@{0}', { exact: true });
    const date = stash.locator('time');

    await expect(number).toBeVisible();
    await expect(date).toBeVisible();
    await expect(date).toHaveAttribute('datetime', '2026-10-11T09:05:00Z');
    await expect(date).toHaveText('11/10 09:05');
    for (const metadata of [number, date])
      expect(
        await metadata.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    expect(
      await title.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    const boxes = await Promise.all([
      title.boundingBox(),
      number.boundingBox(),
      date.boundingBox(),
    ]);
    const [nameBox, numberBox, dateBox] = boxes;

    expect(nameBox).not.toBeNull();
    expect(numberBox).not.toBeNull();
    expect(dateBox).not.toBeNull();
    if (!nameBox || !numberBox || !dateBox) return;
    expect(numberBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
    expect(dateBox.x).toBeGreaterThanOrEqual(numberBox.x + numberBox.width);
    expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(width);
    const middle = nameBox.y + nameBox.height / 2;

    expect(Math.abs(numberBox.y + numberBox.height / 2 - middle)).toBeLessThan(
      2,
    );
    expect(Math.abs(dateBox.y + dateBox.height / 2 - middle)).toBeLessThan(2);
    await header.click();
    const expandedHeader = stash.getByRole('button', {
      name: `Collapse ${name}`,
    });

    await expect(expandedHeader).toContainText('stash@{0}');
    await expect(stash.getByText('stash@{0}', { exact: true })).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const scroller = root.locator('div[aria-label="Stashes"]');
    const beforeScroll = await expandedHeader.boundingBox();

    expect(beforeScroll).not.toBeNull();
    if (!beforeScroll) return;
    await scroller.evaluate((element) => {
      element.scrollTop = 100;
    });
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBe(100);
    await expect
      .poll(async () => (await expandedHeader.boundingBox())?.y)
      .toBeCloseTo(beforeScroll.y, 0);
    for (const metadata of [number, date]) await expect(metadata).toBeVisible();
    expect(
      await expandedHeader.evaluate((element) => {
        const box = element.getBoundingClientRect();

        return element.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: `.artifacts/stash-header-sticky-${width}.png`,
    });
  });
