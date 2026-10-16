import type { PanelBody } from '../../src/shared/messages';
import { expect, test } from '../fixtures/browser';

test('search options stay inside a compact input at wide panel sizes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 600 });
  await page.goto('/');
  const input = (await page
    .getByRole('searchbox', { name: 'Text or hash' })
    .boundingBox())!;

  expect(input.width).toBeLessThanOrEqual(280);
  for (const name of ['Regular expression', 'Match case']) {
    const button = (await page.getByRole('button', { name }).boundingBox())!;

    expect(button.x).toBeGreaterThan(input.x);
    expect(button.x + button.width).toBeLessThanOrEqual(input.x + input.width);
    expect(button.y).toBeGreaterThanOrEqual(input.y);
    expect(button.y + button.height).toBeLessThanOrEqual(
      input.y + input.height,
    );
  }
});

for (const filter of ['User filter', 'Date filter', 'Branch tree'])
  test(`${filter} retains history until its replacement arrives`, async ({
    page,
  }) => {
    await page.goto('/');
    const first = page.locator('[data-commit-row]').first();
    const originalSha = await first.getAttribute('data-sha');

    await page.evaluate(() => {
      const deliver = window.__deliver;

      window.__deliver = (message) => {
        if (message.body.kind === 'history' && !message.body.append) {
          const response = {
            ...message,
            body: {
              ...message.body,
              page: {
                ...message.body.page,
                commits: message.body.page.commits.slice(3, 6),
                nextCursor: null,
              },
            },
          };

          window.addEventListener(
            'finish-filter',
            () => {
              window.__deliver = deliver;
              deliver(response);
            },
            { once: true },
          );
        } else deliver(message);
      };
    });
    if (filter === 'User filter') {
      await page.getByRole('button', { name: filter, exact: true }).click();
      await page.getByRole('button', { name: 'Me', exact: true }).click();
    } else if (filter === 'Date filter') {
      await page.getByRole('button', { name: filter }).click();
      await page
        .getByRole('button', { name: 'Last 7 days', exact: true })
        .click();
    } else
      await page
        .getByRole('treeitem', { name: 'topic', exact: true })
        .dblclick();
    await expect(page.locator('#history-pane')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(first).toHaveAttribute('data-sha', originalSha!);
    await expect(page.locator('#history')).toHaveAttribute('inert', '');
    const requests = await page.evaluate(() => window.__requests.length);

    await first.dispatchEvent('click');
    expect(await page.evaluate(() => window.__requests.length)).toBe(requests);
    await page.evaluate(() => window.dispatchEvent(new Event('finish-filter')));
    await expect(first).toHaveAttribute('data-sha', '4'.padStart(40, '0'));
    await expect(page.locator('#history')).not.toHaveAttribute('inert', '');
  });

test('commit switching retains its files and summary until both replacement responses arrive', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-subject-message]').first().click();
  await page.evaluate(() => {
    const request = window.__requests.at(-1)!;

    window.__deliver({
      ...request,
      body: {
        kind: 'files',
        sha: '1'.padStart(40, '0'),
        parentSha: '2'.padStart(40, '0'),
        files: [
          {
            id: 'original-file',
            status: 'modified',
            oldPath: 'original.txt',
            newPath: 'original.txt',
          },
        ],
      },
    });
  });
  await expect(page.locator('[data-file]')).toBeVisible();
  const originalMessage = await page
    .locator('[data-commit-info] pre')
    .textContent();
  const originalFile = await page
    .locator('[data-file]')
    .getAttribute('data-file');

  await page.locator('[data-file]').click({ trial: true });
  const originalBounds = await page.locator('[data-file]').boundingBox();

  await page.evaluate(() => {
    const deliver = window.__deliver;

    window.__deliver = (message) => {
      if (message.body.kind === 'details' || message.body.kind === 'files') {
        const kind = message.body.kind;
        const response =
          kind === 'files'
            ? {
                ...message,
                body: {
                  ...message.body,
                  files: [
                    {
                      id: 'next-file',
                      status: 'added' as const,
                      oldPath: null,
                      newPath: 'next.txt',
                    },
                  ],
                },
              }
            : message;

        window.addEventListener('finish-' + kind, () => deliver(response), {
          once: true,
        });
      } else deliver(message);
    };
  });
  await page.locator('[data-subject-message]').nth(1).click();
  const changedFiles = page.getByRole('region', { name: 'Changed files' });
  const progress = changedFiles.locator(':scope > [aria-hidden="true"]');

  await expect(changedFiles).toHaveAttribute('aria-busy', 'true');
  await expect(progress).toHaveCSS('height', '2px');
  expect(await page.locator('[data-file]').boundingBox()).toEqual(
    originalBounds,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(progress).toHaveCSS('animation-name', 'none');
  const sectionBounds = (await changedFiles.boundingBox())!;
  const progressBounds = (await progress.boundingBox())!;

  expect(progressBounds.y).toBe(sectionBounds.y);
  expect(progressBounds.x).toBeGreaterThanOrEqual(sectionBounds.x);
  expect(progressBounds.x + progressBounds.width).toBeLessThanOrEqual(
    sectionBounds.x + sectionBounds.width,
  );
  await page.screenshot({ path: '.artifacts/changed-files-progress.png' });
  await expect(page.locator('#details')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-commit-info] pre')).toHaveText(
    originalMessage!,
  );
  await expect(page.locator('[data-file]')).toHaveAttribute(
    'data-file',
    originalFile!,
  );
  await expect(page.locator('#details')).toHaveAttribute('inert', '');
  const requests = await page.evaluate(() => window.__requests.length);

  await page.locator('[data-file]').dispatchEvent('dblclick');
  expect(await page.evaluate(() => window.__requests.length)).toBe(requests);
  await page.evaluate(() => window.dispatchEvent(new Event('finish-details')));
  await expect(progress).toBeVisible();
  await expect(page.locator('[data-commit-info] pre')).toHaveText(
    originalMessage!,
  );
  await expect(page.locator('[data-file]')).toHaveAttribute(
    'data-file',
    originalFile!,
  );
  await page.evaluate(() => window.dispatchEvent(new Event('finish-files')));
  await expect(page.locator('[data-commit-info] pre')).toHaveText('Commit 2');
  await expect(page.locator('[data-file]')).toHaveAttribute(
    'data-file',
    'next-file',
  );
  await expect(page.locator('#details')).toHaveAttribute('aria-busy', 'false');
  await expect(changedFiles).toHaveAttribute('aria-busy', 'false');
  await expect(progress).toHaveCount(0);
  await expect(page.locator('#details')).not.toHaveAttribute('inert', '');
});

test('replacement history reconciles a late scroll from its retained viewport', async ({
  page,
}) => {
  await page.goto('/');
  const history = page.locator('#history');

  await expect(history).toHaveJSProperty('scrollTop', 0);
  await page.evaluate(() => {
    const repository = {
      id: 'one',
      label: 'Example repository',
      rootUri: 'file:///example',
      headSha: '1'.padStart(40, '0'),
      branch: 'main',
    };
    const send = (body: PanelBody) =>
      window.__deliver({
        requestId: 'refresh',
        repositoryId: 'one',
        generation: 2,
        body,
      });

    send({
      kind: 'loading',
      repository,
      scope: { kind: 'head' },
      text: '',
      preserve: true,
    });
    Reflect.set(window, 'finishHistoryRefresh', () => {
      send({
        kind: 'history',
        repository,
        scope: { kind: 'head' },
        text: '',
        restoring: true,
        append: false,
        page: {
          commits: Array.from({ length: 200 }, (_, index) => ({
            sha: (index + 1).toString(16).padStart(40, '0'),
            parents: [(index + 2).toString(16).padStart(40, '0')],
            message: 'Commit ' + (index + 1),
            authorName: 'Fixture author',
            authorEmail: null,
            authorDate: null,
            commitDate: null,
          })),
          refs: [],
          nextCursor: '200',
          scopeId: 'fixture',
        },
      });
      send({ kind: 'history-settled' });
    });
  });
  await expect(history).toHaveAttribute('inert', '');
  // A scroll already queued by the browser can arrive after refresh starts.
  await history.evaluate((node) => {
    node.scrollTop = 3500;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() =>
    (Reflect.get(window, 'finishHistoryRefresh') as () => void)(),
  );
  await expect(history).not.toHaveAttribute('inert', '');
  await expect(history).toHaveJSProperty('scrollTop', 0);
  await history.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.locator('[data-history-content]')).toHaveCSS(
    'height',
    '8800px',
  );
});
