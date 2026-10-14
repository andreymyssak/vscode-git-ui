import { expect, type Locator, test } from '../fixtures/browser';

async function geometry(row: Locator) {
  return row.evaluate((node) => {
    const bounds = (selector: string) => {
      const element = node.querySelector(selector);

      if (!element) throw new Error(`Missing history element: ${selector}`);
      const rect = element.getBoundingClientRect();

      return { x: rect.x, width: rect.width };
    };

    return {
      graph: bounds('[data-commit-graph]'),
      message: bounds('[data-subject-message]'),
      author: bounds('[data-author]'),
      date: bounds('[data-date]'),
    };
  });
}

test('narrow rows keep compact graph spacing when a wide merge is outside the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 350 });
  await page.goto('/');
  await expect(page.locator('[data-commit-row]').first()).toBeVisible();
  const identities = Array.from({ length: 70 }, (_, index) =>
    (index + 1).toString(16).padStart(40, '0'),
  );

  await page.evaluate((identities) => {
    window.__deliver({
      requestId: 'row-graph-widths',
      repositoryId: 'one',
      generation: 1,
      body: {
        kind: 'history',
        append: false,
        scope: { kind: 'all' },
        text: '',
        repository: {
          id: 'one',
          label: 'Row graph fixture',
          rootUri: 'file:///example',
          branch: 'main',
          headSha: identities[0]!,
        },
        page: {
          scopeId: 'row-graph-widths',
          nextCursor: null,
          commits: identities.map((sha, index) => ({
            sha,
            parents:
              index === 45
                ? identities.slice(46, 62)
                : identities.slice(index + 1, index + 2),
            message: index === 45 ? 'Wide merge' : `Narrow row ${index + 1}`,
            authorName: 'Graph Author',
            authorEmail: 'graph@example.test',
            authorDate: '2026-10-01T09:00:00Z',
            commitDate: '2026-10-01T09:00:00Z',
          })),
          refs: [],
        },
      },
    });
  }, identities);
  const first = page.locator(`[data-commit-row][data-sha="${identities[0]}"]`);
  const merge = page.locator(`[data-commit-row][data-sha="${identities[45]}"]`);

  await expect(first).toContainText('Narrow row 1');
  await expect(merge).toHaveCount(0);
  const before = await geometry(first);

  expect(before.graph.width).toBe(22);
  expect(before.message.x).toBeCloseTo(before.graph.x + 22, 0);
  await page.locator('#history').evaluate((node) => {
    node.scrollTop = 45 * 22;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(merge).toBeVisible();
  const wide = await geometry(merge);

  expect(wide.graph.width).toBe(187);
  expect(wide.message.x).toBeCloseTo(wide.graph.x + 187, 0);
  expect(wide.message.x + wide.message.width).toBeLessThanOrEqual(
    wide.author.x,
  );
  expect(wide.author.x).toBeCloseTo(before.author.x, 0);
  expect(wide.date.x).toBeCloseTo(before.date.x, 0);
  await page.locator('#history').evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(first).toBeVisible();
  const after = await geometry(first);

  expect(after.graph.width).toBe(22);
  expect(after.message.x).toBeCloseTo(before.message.x, 0);
});
