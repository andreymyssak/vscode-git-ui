import { expect, test } from '../fixtures/browser';

test('retained branches wait for fresh reference metadata, then unlock before the graph finishes', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'refresh',
      repositoryId: 'one',
      generation: 2,
      body: {
        kind: 'loading',
        repository: {
          id: 'one',
          label: 'Example',
          rootUri: 'file:///example',
          branch: 'main',
          headSha: '1'.padStart(40, '0'),
        },
        preserve: true,
        scope: { kind: 'head' },
        text: '',
      },
    }),
  );
  const topic = page.locator('[data-ref="refs/heads/topic"]');
  const context = async () =>
    JSON.parse((await topic.getAttribute('data-vscode-context'))!);

  await expect.poll(async () => (await context()).logOperationBusy).toBe(true);
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'refresh',
      repositoryId: 'one',
      generation: 2,
      body: {
        kind: 'references',
        references: ['main', 'topic'].map((name) => ({
          id: `refs/heads/${name}`,
          name,
          kind: 'local',
          sha: '1'.padStart(40, '0'),
          remote: null,
        })),
      },
    }),
  );
  await expect.poll(async () => (await context()).logOperationBusy).toBe(false);
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
});

test('waiting branches are labelled separately and unrelated menus stay available', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'update-first',
      repositoryId: 'one',
      generation: 1,
      body: {
        kind: 'operation-progress',
        operation: {
          label: 'Updating main…',
          refIds: ['refs/heads/main'],
          phase: 'running',
          queued: [
            { label: 'Updating topic…', refIds: ['refs/heads/topic'] },
            { label: 'Fetching remotes…', refIds: [], section: 'branches' },
          ],
        },
      },
    }),
  );
  await expect(
    page.locator('[data-ref="refs/heads/main"]').getByLabel('Updating main…'),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-ref="refs/heads/topic"]')
      .getByLabel('Queued: Updating topic…'),
  ).toBeVisible();
  const queuedSpinner = page.locator(
    '[data-ref="refs/heads/topic"] .codicon-loading',
  );

  await expect(queuedSpinner).toBeVisible();
  await expect
    .poll(() =>
      queuedSpinner.evaluate((element) => element.getAnimations().length),
    )
    .toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(queuedSpinner).toHaveCSS('animation-name', 'none');
  await expect(page.locator('#fetch')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#fetch .codicon-loading')).toBeVisible();
  await expect(page.getByRole('status')).toBeHidden();
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator('#fetch')).toBeEnabled();
  const context = JSON.parse(
    (await page
      .locator('[data-commit-row]')
      .first()
      .getAttribute('data-vscode-context'))!,
  );

  expect(context.logOperationBusy).toBe(false);
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'update-second',
      repositoryId: 'one',
      generation: 2,
      body: {
        kind: 'operation-progress',
        operation: {
          label: 'Updating topic…',
          refIds: ['refs/heads/topic'],
          phase: 'running',
        },
      },
    }),
  );
  await expect(
    page.locator('[data-ref="refs/heads/main"]').getByLabel('Updating main…'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-ref="refs/heads/topic"]').getByLabel('Updating topic…'),
  ).toBeVisible();
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'update-second',
      repositoryId: 'one',
      generation: 2,
      body: { kind: 'operation-progress', operation: null },
    }),
  );
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.getByRole('status')).toBeHidden();
  await expect(page.locator('#branches .codicon-loading')).toHaveCount(0);
  await expect(page.locator('#fetch')).toHaveAttribute('aria-busy', 'false');
});
