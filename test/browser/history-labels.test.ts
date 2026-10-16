import type { Frame } from '@playwright/test';

import { expect, type Page, test } from '../fixtures/browser';

test.use({ locale: 'en-US', timezoneId: 'UTC' });

async function showHistory(
  page: Page | Frame,
  subject = 'A long commit subject '.repeat(25),
  generation = 1,
) {
  await page.evaluate(
    ({ subject, generation }) => {
      const request = window.__requests.at(-1)!;
      const sha = '1'.padStart(40, '0');

      window.__deliver({
        ...request,
        generation,
        body: {
          kind: 'history',
          append: false,
          scope: { kind: 'head' },
          text: '',
          repository: {
            id: 'one',
            label: 'Example repository',
            rootUri: 'file:///example',
            headSha: sha,
            branch: 'main',
          },
          page: {
            commits: [1, 2].map((value) => ({
              sha: String(value).padStart(40, '0'),
              parents: [String(value + 1).padStart(40, '0')],
              message: subject,
              authorName: 'Author with a long name',
              authorEmail: null,
              authorDate: null,
              commitDate: '2026-10-05T00:00:00Z',
            })),
            refs: [
              {
                id: 'refs/tags/v10',
                name: 'v10',
                kind: 'tag',
                sha,
                remote: null,
              },
              {
                id: 'refs/tags/v2',
                name: 'v2',
                kind: 'tag',
                sha,
                remote: null,
              },
              {
                id: 'refs/remotes/origin/main',
                name: 'origin/main',
                kind: 'remote',
                sha,
                remote: 'origin',
              },
              {
                id: 'refs/heads/topic',
                name: 'topic',
                kind: 'local',
                sha,
                remote: null,
              },
              {
                id: 'refs/heads/main',
                name: 'main',
                kind: 'local',
                sha,
                remote: null,
              },
              ...Array.from({ length: 50 }, (_, index) => ({
                id: `refs/tags/release/${index}`,
                name: `release/${index}`,
                kind: 'tag' as const,
                sha,
                remote: null,
              })),
              {
                id: 'refs/tags/v10-old',
                name: 'v10',
                kind: 'tag',
                sha: '2'.padStart(40, '0'),
                remote: null,
              },
              {
                id: 'refs/tags/v2-old',
                name: 'v2',
                kind: 'tag',
                sha: '2'.padStart(40, '0'),
                remote: null,
              },
            ],
            nextCursor: null,
            scopeId: 'fixture',
          },
        },
      });
    },
    { subject, generation },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await showHistory(page);
});

test('many references show one label and expose every sorted reference on hover', async ({
  page,
}) => {
  const row = page.locator('[data-commit-row]').first();
  const labels = row.locator('[data-ref-label]');

  await expect(labels).toHaveCount(1);
  await expect(labels).toHaveText('main');
  const references = row.locator('[data-references]');
  const title = (await references.getAttribute('aria-label'))!;

  expect(title.split('\n').slice(0, 4)).toEqual([
    'HEAD',
    'Local branch: main',
    'Local branch: topic',
    'Remote-tracking branch: origin/main',
  ]);
  expect(title).toContain('Tag: release/49');
  expect(title.indexOf('Tag: v2\n')).toBeLessThan(title.indexOf('Tag: v10'));
  await expect(references).toHaveAttribute('aria-label', title);
  await expect(
    row.getByRole('group', { name: title, exact: true }),
  ).toHaveCount(1);
  await references.hover();
  const tooltip = page.getByRole('tooltip');

  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('HEAD');
  await expect(tooltip).toContainText('Current checkout');
  await expect(tooltip).toContainText('origin/main');
  await expect(tooltip).toContainText('Remote-tracking branch');
  await expect(tooltip).toContainText('release/49');
  expect(
    await row.locator('[data-ref-stack] [data-ref-symbol]').count(),
  ).toBeLessThanOrEqual(3);
  await expect(
    page.locator('[data-commit-row]').nth(1).locator('[data-ref-label]'),
  ).toHaveText('v2');
});

test('hover references stay readable above the pane and dismiss with Escape or leaving', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 280 });
  const references = page
    .locator('[data-commit-row]')
    .first()
    .locator('[data-references]');

  await references.hover();
  const tooltip = page.getByRole('tooltip');

  await expect(tooltip).toBeVisible();
  const bounds = (await tooltip.boundingBox())!;

  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(960);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(280);
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await page.mouse.move(5, 5);
  await references.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(tooltip).toBeHidden();
});

test('reference list remains open when moving between its marker and list', async ({
  page,
}) => {
  await page.clock.install();
  const references = page
    .locator('[data-commit-row]')
    .nth(1)
    .locator('[data-references]');

  await references.hover();
  await page.clock.runFor(300);
  const tooltip = page.getByRole('tooltip');

  await expect(tooltip).toBeVisible();
  await tooltip.hover();
  await references.hover();
  await page.clock.runFor(250);
  await expect(tooltip).toBeVisible();
});

test('keyboard focus exposes reference names and Escape dismisses them', async ({
  page,
}) => {
  const references = page
    .locator('[data-commit-row]')
    .first()
    .locator('[data-references]');

  await references.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('tooltip')).toContainText('origin/main');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(references).toBeFocused();
});

test('a replaced history snapshot retires reference popups for retained commits', async ({
  page,
}) => {
  const references = page
    .locator('[data-commit-row]')
    .first()
    .locator('[data-references]');

  await references.focus();
  const tooltip = page.locator('[data-reference-tooltip]');

  await expect(tooltip).toBeVisible();
  await showHistory(page, undefined, 2);
  await expect(tooltip).toHaveCount(0);
  await expect(references).toBeFocused();
  await references.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('origin/main');
});

async function embeddedHistory(page: Page) {
  const url = page.url();

  await page.setContent(
    `<button>Editor</button><iframe title="Git UI" src="${url}" style="width:100%;height:600px"></iframe>`,
  );
  await expect.poll(() => page.frames().length).toBe(2);
  const frame = page.frames().find((candidate) => candidate.parentFrame());

  if (!frame) throw new Error('Git UI webview frame is missing.');
  await frame.waitForFunction(() => window.__requests?.length > 0);
  await showHistory(frame);

  return frame;
}

test('reference popups close when the webview loses window focus', async ({
  page,
}) => {
  const frame = await embeddedHistory(page);
  const references = frame
    .locator('[data-commit-row]')
    .first()
    .locator('[data-references]');

  await references.focus();
  const tooltip = frame.locator('[data-reference-tooltip]');

  await expect.poll(() => frame.evaluate(() => document.hasFocus())).toBe(true);
  await expect(tooltip).toBeVisible();
  await page.getByRole('button', { name: 'Editor', exact: true }).focus();
  await expect
    .poll(() => frame.evaluate(() => document.hasFocus()))
    .toBe(false);
  await expect(tooltip).toHaveCount(0);
  await frame.getByRole('button', { name: 'Refresh', exact: true }).focus();
  await expect(tooltip).toHaveCount(0);
});

test('a delayed reference hover cannot open after the webview loses focus', async ({
  page,
}) => {
  const frame = await embeddedHistory(page);

  await frame.getByRole('button', { name: 'Refresh', exact: true }).focus();
  await expect.poll(() => frame.evaluate(() => document.hasFocus())).toBe(true);
  await page.clock.install();
  await frame
    .locator('[data-commit-row]')
    .first()
    .locator('[data-references]')
    .hover();
  await page.clock.runFor(100);
  await page.getByRole('button', { name: 'Editor', exact: true }).focus();
  await expect
    .poll(() => frame.evaluate(() => document.hasFocus()))
    .toBe(false);
  await page.clock.runFor(400);
  await expect(frame.locator('[data-reference-tooltip]')).toHaveCount(0);
});

test('a focused reference list follows a smaller viewport without clipping', async ({
  page,
}) => {
  await page
    .locator('[data-commit-row]')
    .first()
    .locator('[data-references]')
    .focus();
  const tooltip = page.getByRole('tooltip');

  await expect(tooltip).toBeVisible();
  await page.setViewportSize({ width: 960, height: 280 });
  await expect
    .poll(async () => {
      const bounds = await tooltip.boundingBox();

      return (
        bounds !== null &&
        bounds.x >= 8 &&
        bounds.y >= 8 &&
        bounds.x + bounds.width <= 952 &&
        bounds.y + bounds.height <= 272
      );
    })
    .toBe(true);
});

test('hover exposes complete long reference names instead of clipping them', async ({
  page,
}) => {
  const name = 'feature/' + 'long-description/'.repeat(18) + 'final';

  await page.evaluate((name) => {
    const request = window.__requests.at(-1)!;
    const sha = '1'.padStart(40, '0');

    window.__deliver({
      ...request,
      generation: 1,
      body: {
        kind: 'history',
        append: false,
        scope: { kind: 'head' },
        text: '',
        repository: {
          id: 'one',
          label: 'Example repository',
          rootUri: 'file:///example',
          headSha: sha,
          branch: 'main',
        },
        page: {
          commits: [
            {
              sha,
              parents: ['2'.padStart(40, '0')],
              message: 'Long reference fixture',
              authorName: 'Fixture author',
              authorEmail: null,
              authorDate: null,
              commitDate: null,
            },
          ],
          refs: [
            {
              id: `refs/heads/${name}`,
              name,
              kind: 'local',
              sha,
              remote: null,
            },
          ],
          nextCursor: null,
          scopeId: 'fixture',
        },
      },
    });
  }, name);
  await page.setViewportSize({ width: 960, height: 280 });
  await page
    .locator('[data-commit-row]')
    .first()
    .locator('[data-references]')
    .hover();
  const tooltip = page.getByRole('tooltip');

  await expect(tooltip).toBeVisible();
  const label = tooltip.getByText(name, { exact: true });

  await expect(label).toBeVisible();
  const bounds = await label.evaluate((node) => ({
    width: node.clientWidth,
    contentsWidth: node.scrollWidth,
  }));

  expect(bounds.contentsWidth).toBeLessThanOrEqual(bounds.width);
});

test('selecting a commit does not select its text or reference glyphs', async ({
  page,
}) => {
  const row = page.locator('[data-commit-row]').first();
  const bounds = (await row.locator('[data-subject-message]').boundingBox())!;

  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 100, bounds.y + bounds.height / 2, {
    steps: 10,
  });
  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ''),
  ).toBe('');
  await page.mouse.up();
  await row.click();
  await expect(page.locator('[data-commit-row]').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('references stay at the end of the history cell without overlapping messages or metadata', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 280 });
  const rows = page.locator('[data-commit-row]');

  await expect(rows.first().locator('[data-subject-message]')).toBeVisible();
  const [first, next] = await rows.evaluateAll((nodes) =>
    nodes.map((node) => {
      const bounds = (selector: string) => {
        const rect = node.querySelector(selector)!.getBoundingClientRect();

        return { x: rect.x, width: rect.width };
      };

      return {
        history: node.children[0]!.getBoundingClientRect().toJSON(),
        subject: bounds('[data-subject-message]'),
        references: bounds('[data-references]'),
        author: bounds('[data-author]'),
      };
    }),
  );
  const { subject, references, author } = first!;

  expect(subject.width).toBeGreaterThanOrEqual(100);
  expect(subject.x + subject.width).toBeLessThanOrEqual(references.x);
  expect(references.x + references.width).toBeLessThanOrEqual(author.x);
  expect(references.x + references.width).toBeCloseTo(first!.history.right, 0);
  expect(next!.author.x).toBe(author.x);
});

test('history has three cells with graph, subject and references together', async ({
  page,
}) => {
  const row = page.locator('[data-commit-row]').first();
  const cells = row.getByRole('cell');

  await expect(cells).toHaveCount(3);
  await expect(cells.nth(0).locator('svg')).toBeVisible();
  await expect(cells.nth(0).locator('[data-subject-message]')).toBeVisible();
  await expect(cells.nth(0).locator('[data-ref-label]')).toHaveText('main');
  await expect(cells.nth(1)).toHaveText('Author with a long name');
  await expect(cells.nth(2)).toHaveText('10/5/26, 12:00 AM');
});

test('short subjects give references room while their trailing edge stays aligned', async ({
  page,
}) => {
  await showHistory(page, 'Short subject');
  const row = page.locator('[data-commit-row]').first();

  await expect(row.locator('[data-subject-message]')).toHaveText(
    'Short subject',
  );
  const { history, reference } = await row.evaluate((node) => {
    const history = node.children[0]!.getBoundingClientRect();
    const reference = node
      .querySelector('[data-references]')!
      .getBoundingClientRect();

    return {
      history: { x: history.x, width: history.width },
      reference: { x: reference.x, width: reference.width },
    };
  });

  expect(reference.x).toBeGreaterThan(history.x + history.width / 2);
  expect(reference.x + reference.width).toBeCloseTo(
    history.x + history.width,
    0,
  );
});

test('graph cells fit their row and message, references, author and date share a text baseline', async ({
  page,
}) => {
  const row = page.locator('[data-commit-row]').first();
  const geometry = await row.evaluate((node) => {
    const rowBounds = node.getBoundingClientRect();
    const cells = [...node.children].map(
      (cell) => cell.getBoundingClientRect().height,
    );
    const textCenters = [
      '[data-subject-message]',
      '[data-ref-label]',
      '[data-author]',
      '[data-date]',
    ].map((selector) => {
      const range = document.createRange();

      range.selectNodeContents(node.querySelector(selector)!);
      const bounds = range.getBoundingClientRect();

      return bounds.y + bounds.height / 2;
    });

    return { height: rowBounds.height, cells, textCenters };
  });

  for (const height of geometry.cells) expect(height).toBe(geometry.height);
  expect(
    Math.max(...geometry.textCenters) - Math.min(...geometry.textCenters),
  ).toBeLessThanOrEqual(1);
});

for (const selection of ['#303030', '#ffffff20'])
  test(`reference markers have no background blocks and preserve their colors with selection ${selection}`, async ({
    page,
  }) => {
    await page.addStyleTag({
      content: `:root { --vscode-editor-background: #101010; --vscode-list-activeSelectionBackground: ${selection}; } body { background: var(--vscode-editor-background); }`,
    });
    const row = page.locator('[data-commit-row]').first();
    const markers = row.locator('[data-ref-stack] [data-ref-symbol]');
    const before = await markers.evaluateAll((nodes) =>
      nodes.map((node) => ({
        background: getComputedStyle(node).backgroundColor,
        color: getComputedStyle(node).color,
      })),
    );

    expect(before.map((marker) => marker.background)).toEqual(
      before.map(() => 'rgba(0, 0, 0, 0)'),
    );
    await row.click();
    const after = await markers.evaluateAll((nodes) =>
      nodes.map((node) => ({
        background: getComputedStyle(node).backgroundColor,
        color: getComputedStyle(node).color,
      })),
    );

    expect(after.map((marker) => marker.background)).toEqual(
      after.map(() => 'rgba(0, 0, 0, 0)'),
    );
    expect(after.map((marker) => marker.color)).toEqual(
      before.map((marker) => marker.color),
    );
  });
