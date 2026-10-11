import { expect, test } from '../fixtures/browser';

test('invalid dates request a native notification and keep the period editable', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Date filter', exact: true }).click();
  await page.getByRole('button', { name: 'Select period…' }).click();
  await page.getByLabel('From', { exact: true }).fill('2026-10-07');
  await page.getByLabel('To', { exact: true }).fill('2026-10-01');
  const before = (await page.evaluate(() => window.__requests)).filter(
    ({ body }) => body.kind === 'history',
  ).length;

  await page.getByRole('button', { name: 'Apply dates' }).click();
  expect((await page.evaluate(() => window.__requests)).at(-1)?.body).toEqual({
    kind: 'invalid-date-filter',
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByText('Start date must be on or before end date.'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('dialog', { name: 'Filter by committed date' }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      ({ body }) => body.kind === 'history',
    ),
  ).toHaveLength(before);
  await page.getByLabel('To', { exact: true }).fill('2026-10-08');
  await page.getByRole('button', { name: 'Apply dates' }).click();
  expect(
    (await page.evaluate(() => window.__requests)).at(-1)?.body,
  ).toMatchObject({
    kind: 'history',
    filters: { date: { kind: 'range', from: '2026-10-07', to: '2026-10-08' } },
  });
});

test('calendar range applies once, survives reopening and clears independently', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('treeitem', { name: 'topic', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Date filter', exact: true }).click();
  await page.getByRole('button', { name: 'Select period…' }).click();
  await page.getByLabel('From', { exact: true }).fill('2026-10-01');
  await page.getByLabel('To', { exact: true }).fill('2026-10-06');
  await page
    .getByRole('dialog', { name: 'Filter by committed date' })
    .screenshot({ path: '.artifacts/date-popover-simplified.png' });
  const before = (await page.evaluate(() => window.__requests)).filter(
    (request) => request.body.kind === 'history',
  ).length;

  await page.getByRole('button', { name: 'Apply dates' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Filter by committed date' }),
  ).toBeHidden();
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (request) => request.body.kind === 'history',
    ),
  ).toHaveLength(before + 1);
  expect(
    (await page.evaluate(() => window.__requests)).at(-1)?.body,
  ).toMatchObject({
    kind: 'history',
    scope: { kind: 'ref', refId: 'refs/heads/topic' },
    filters: { date: { kind: 'range', from: '2026-10-01', to: '2026-10-06' } },
  });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Date filter', exact: true }),
  ).toHaveText('Period');
  await page.getByRole('button', { name: 'Date filter', exact: true }).click();
  await page.getByRole('button', { name: 'Select period…' }).click();
  await expect(page.getByLabel('To', { exact: true })).toHaveValue(
    '2026-10-06',
  );
  await page.getByRole('button', { name: 'Clear date filter' }).click();
  await expect(page.locator('#scope')).toHaveText('topic');
  expect(
    (await page.evaluate(() => window.__requests)).at(-1)?.body,
  ).toMatchObject({ filters: { date: 'all' } });
});

for (let mask = 0; mask < 8; mask++)
  test(`visible column combination ${mask} uses adjacent resize handles and preserves preferences`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 600 });
    await page.goto('/');
    await expect(page.locator('[data-commit-row]').first()).toBeVisible();
    const before = (await page.evaluate(() => window.__requests)).filter(
      (request) => request.body.kind === 'history',
    ).length;
    const author = !!(mask & 1);
    const date = !!(mask & 2);
    const hash = !!(mask & 4);

    await page.getByRole('button', { name: 'View options' }).click();
    await page.getByRole('button', { name: 'Columns', exact: true }).hover();
    for (const [name, value] of [
      ['Author', author],
      ['Date', date],
      ['Hash', hash],
    ] as const)
      await page.getByRole('checkbox', { name, exact: true }).setChecked(value);
    await page.keyboard.press('Escape');
    const row = page.locator('[data-commit-row]').first();

    await expect(row.locator('[role=cell]')).toHaveCount(
      1 + Number(author) + Number(date) + Number(hash),
    );
    const names = [
      'Commit',
      ...(author ? ['Author'] : []),
      ...(date ? ['Date'] : []),
      ...(hash ? ['Revision'] : []),
    ];
    const handles = page.locator('[data-history-column-resizer]');

    await expect(handles).toHaveCount(names.length - 1);
    if (names.length > 1) {
      const boundary = page.getByRole('separator', {
        name: `Resize ${names[0]} and ${names[1]} columns`,
      });
      const width = (await row.locator('[role=cell]').first().boundingBox())!
        .width;

      await boundary.focus();
      await page.keyboard.press('ArrowRight');
      expect(
        (await row.locator('[role=cell]').first().boundingBox())!.width,
      ).toBeCloseTo(width + 10, 1);
    }

    expect(
      (await page.evaluate(() => window.__requests)).filter(
        (request) => request.body.kind === 'history',
      ),
    ).toHaveLength(before);
    await page.reload();
    await expect(row.locator('[role=cell]')).toHaveCount(names.length);
    await page.getByRole('button', { name: 'View options' }).click();
    await page.getByRole('button', { name: 'Columns', exact: true }).hover();
    await expect(
      page.getByRole('checkbox', { name: 'Author', exact: true }),
    ).toBeChecked({ checked: author });
    await expect(
      page.getByRole('checkbox', { name: 'Date', exact: true }),
    ).toBeChecked({ checked: date });
    await expect(
      page.getByRole('checkbox', { name: 'Hash', exact: true }),
    ).toBeChecked({ checked: hash });
  });

for (const hidden of ['Author', 'Date'] as const)
  test(`resetting visible columns preserves the hidden ${hidden} width`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 600 });
    await page.goto('/');
    const row = page.locator('[data-commit-row]').first();
    const original = hidden === 'Author' ? 1 : 2;
    const divider = page.getByRole('separator', {
      name: 'Resize Author and Date columns',
    });

    await divider.focus();
    await page.keyboard.press(hidden === 'Author' ? 'ArrowRight' : 'ArrowLeft');
    const saved = (await row
      .locator('[role=cell]')
      .nth(original)
      .boundingBox())!.width;

    await page.getByRole('button', { name: 'View options' }).click();
    await page.getByRole('button', { name: 'Columns', exact: true }).hover();
    await page.getByRole('checkbox', { name: hidden, exact: true }).uncheck();
    await page.keyboard.press('Escape');
    await page
      .getByRole('separator', {
        name: `Resize Commit and ${hidden === 'Author' ? 'Date' : 'Author'} columns`,
      })
      .dblclick();
    await page.getByRole('button', { name: 'View options' }).click();
    await page.getByRole('button', { name: 'Columns', exact: true }).hover();
    await page.getByRole('checkbox', { name: hidden, exact: true }).check();
    await page.keyboard.press('Escape');
    expect(
      (await row.locator('[role=cell]').nth(original).boundingBox())!.width,
    ).toBeCloseTo(saved, 1);
    await page.reload();
    expect(
      (await row.locator('[role=cell]').nth(original).boundingBox())!.width,
    ).toBeCloseTo(saved, 1);
  });

test('highlights differ from selection and toggle without reloading history', async ({
  page,
}) => {
  await page.goto('/?highlight-fixture');
  const rows = page.locator('[data-commit-row]');
  const current = rows.nth(0);
  const other = rows.nth(1);
  const background = await current.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );

  await expect(current.locator('[data-author]')).toHaveCSS(
    'font-weight',
    '600',
  );
  expect(
    await other.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).not.toBe(background);
  await expect(current).toHaveAttribute('aria-selected', 'false');
  await current.click();
  await expect(current).toHaveAttribute('aria-selected', 'true');
  expect(
    await current.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).not.toBe(background);
  const foreground = await current.evaluate(
    (node) => getComputedStyle(node).color,
  );

  await expect(current.locator('[data-author]')).toHaveCSS('color', foreground);
  const before = (await page.evaluate(() => window.__requests)).filter(
    (request) => request.body.kind === 'history',
  ).length;

  await page.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('button', { name: 'Columns', exact: true }).hover();
  for (const name of ['My Commits', 'Merge Commits', 'Current Branch'])
    await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await expect(current.locator('[data-author]')).toHaveCSS(
    'font-weight',
    '400',
  );
  await expect(current).toHaveAccessibleDescription('Current checkout');
  await expect(current.locator('[data-commit-graph] svg circle')).toHaveCount(
    2,
  );
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (request) => request.body.kind === 'history',
    ),
  ).toHaveLength(before);
  await page.reload();
  await page.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('button', { name: 'Columns', exact: true }).hover();
  await expect(
    page.getByRole('checkbox', { name: 'Current Branch', exact: true }),
  ).not.toBeChecked();
  await page.screenshot({
    path: '.artifacts/presentation-options-preview.png',
  });
});

test('search explanations and icons fit inside the input with vertical padding', async ({
  page,
}) => {
  await page.goto('/');
  const input = (await page
    .getByRole('searchbox', { name: 'Text or hash' })
    .boundingBox())!;
  const regex = page.getByRole('button', { name: 'Regular expression' });
  const bounds = (await regex.boundingBox())!;

  expect(bounds.y - input.y).toBeGreaterThanOrEqual(3);
  expect(
    input.y + input.height - bounds.y - bounds.height,
  ).toBeGreaterThanOrEqual(3);
  await regex.hover();
  await expect(page.getByRole('tooltip')).toContainText('pattern');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

for (const height of [200, 230])
  test(`date and view options remain usable in a ${height}px bottom panel`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height });
    await page.goto('/');
    await page.getByRole('button', { name: 'View options' }).click();
    await page.getByRole('button', { name: 'Columns', exact: true }).hover();
    const options = page.getByRole('dialog', { name: 'History view options' });
    const optionBounds = (await options.boundingBox())!;

    expect(optionBounds.y).toBeGreaterThanOrEqual(8);
    expect(optionBounds.y + optionBounds.height).toBeLessThanOrEqual(
      height - 8,
    );
    await page
      .getByRole('checkbox', { name: 'Current Branch', exact: true })
      .uncheck();
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'Date filter', exact: true })
      .click();
    await page.getByRole('button', { name: 'Select period…' }).click();
    const dates = page.getByRole('dialog', {
      name: 'Filter by committed date',
    });
    const dateBounds = (await dates.boundingBox())!;

    expect(dateBounds.y).toBeGreaterThanOrEqual(8);
    await expect
      .poll(async () => {
        const bounds = (await dates.boundingBox())!;

        return bounds.y + bounds.height;
      })
      .toBeLessThanOrEqual(height - 8);
    await page.getByLabel('From', { exact: true }).fill('2026-10-01');
    await page.getByRole('button', { name: 'Apply dates' }).click();
    await expect(
      page.getByRole('button', { name: 'Date filter', exact: true }),
    ).toHaveText('Period');
  });

test('Columns hover submenu stays reachable and supports keyboard return', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 600 });
  await page.goto('/');
  await page.getByRole('button', { name: 'View options' }).click();
  const columns = page.getByRole('button', { name: 'Columns', exact: true });

  await columns.hover();
  const author = page.getByRole('checkbox', { name: 'Author', exact: true });

  await author.hover();
  await expect(author).toBeVisible();
  await author.uncheck();
  await expect(author).not.toBeChecked();
  await columns.focus();
  await page.keyboard.press('ArrowRight');
  await expect(author).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(columns).toBeFocused();
  await expect(columns).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'View options' }),
  ).toBeFocused();
});
