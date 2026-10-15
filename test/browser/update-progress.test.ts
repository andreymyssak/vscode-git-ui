import { expect, test } from '../fixtures/browser';

for (const width of [620, 1280])
  test(`Update keeps history visible and spins its branch only during the Git write at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 360 });
    await page.goto('/');
    await page.evaluate(() => {
      window.__deliver({
        requestId: 'tracking',
        repositoryId: 'one',
        generation: 1,
        body: {
          kind: 'references',
          references: ['main', 'topic'].map((name) => ({
            id: `refs/heads/${name}`,
            name,
            kind: 'local',
            sha: '1'.padStart(40, '0'),
            remote: null,
            tracking: {
              upstream: `refs/remotes/origin/${name}`,
              ahead: 0,
              behind: 3,
            },
          })),
        },
      });
    });
    const current = page.locator('[data-ref="refs/heads/main"]');
    const topic = page.locator('[data-ref="refs/heads/topic"]');
    const history = page.locator('#history-pane');
    const rows = page.locator('[data-commit-row]');
    const first = rows.first();
    const before = await first.boundingBox();
    const count = await rows.count();

    await expect(current.locator('[data-incoming]')).toHaveText('3');
    await page.evaluate(() =>
      window.__deliver({
        requestId: 'update-one',
        repositoryId: 'one',
        generation: 1,
        body: {
          kind: 'operation-progress',
          operation: {
            label: 'Updating main…',
            refIds: ['refs/heads/main'],
            phase: 'running',
          },
        },
      }),
    );
    const spinner = current.getByLabel('Updating main…', { exact: true });

    await expect(spinner).toBeVisible();
    await expect(page.getByRole('status')).toBeHidden();
    await expect(current.locator('.codicon-loading')).toBeVisible();
    await expect(current.locator('[data-incoming]')).toHaveCount(0);
    await expect(topic.locator('[data-incoming]')).toHaveText('3');
    await expect(history).toHaveAttribute('aria-busy', 'false');
    await expect(history.locator(':scope > [aria-hidden="true"]')).toHaveCount(
      0,
    );
    await expect(rows).toHaveCount(count);
    await expect(first).toBeVisible();
    await expect(
      first.locator('xpath=ancestor-or-self::*[@inert]'),
    ).toHaveCount(0);
    expect(await first.boundingBox()).toEqual(before);
    for (const [row, allowed] of [
      [current, false],
      [topic, true],
    ] as const) {
      const context: { refCanUpdate: boolean } = JSON.parse(
        (await row.getAttribute('data-vscode-context'))!,
      );

      expect(context.refCanUpdate).toBe(allowed);
    }

    await spinner.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Updating main…');
    await page.mouse.move(0, 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(current.locator('.codicon-loading')).toHaveCSS(
      'animation-name',
      'none',
    );
    await page.evaluate(() =>
      window.__deliver({
        requestId: 'update-one',
        repositoryId: 'one',
        generation: 1,
        body: {
          kind: 'operation-progress',
          operation: {
            label: 'Updating main…',
            refIds: ['refs/heads/main'],
            phase: 'refreshing',
          },
        },
      }),
    );
    await expect(current.locator('.codicon-loading')).toHaveCount(0);
    await expect(current.locator('[data-incoming]')).toHaveText('3');
    await expect(page.getByRole('status')).toBeHidden();
    await expect(history).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() =>
      window.__deliver({
        requestId: 'update-one',
        repositoryId: 'one',
        generation: 1,
        body: {
          kind: 'operation-progress',
          operation: null,
        },
      }),
    );
    await expect(current.locator('.codicon-loading')).toHaveCount(0);
    await expect(current.locator('[data-incoming]')).toHaveText('3');
    await expect(history).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('status')).toBeHidden();
    const context: { refCanUpdate: boolean } = JSON.parse(
      (await current.getAttribute('data-vscode-context'))!,
    );

    expect(context.refCanUpdate).toBe(true);
  });
