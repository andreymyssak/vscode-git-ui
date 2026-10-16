import { expect, test } from '../fixtures/browser';

test('first-page rows remain usable while optional tracking and highlighting arrive', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() => {
    const sha = (value: number) => value.toString(16).padStart(40, '0');
    const repository = {
      id: 'one',
      label: 'Example repository',
      rootUri: 'file:///example',
      branch: 'main',
      headSha: sha(1),
    };
    const refs = [
      {
        id: 'refs/heads/main',
        name: 'main',
        kind: 'local' as const,
        sha: sha(1),
        remote: null,
      },
    ];
    const send = (body: Parameters<typeof window.__deliver>[0]['body']) =>
      window.__deliver({
        repositoryId: 'one',
        requestId: 'first-page',
        generation: 2,
        body,
      });

    send({ kind: 'loading', repository, scope: { kind: 'all' }, text: '' });
    send({
      kind: 'history',
      repository,
      scope: { kind: 'all' },
      text: '',
      append: false,
      page: {
        scopeId: 'fresh',
        refs,
        nextCursor: null,
        commits: [1, 2].map((value) => ({
          sha: sha(value),
          parents: [sha(value + 1)],
          message: 'Commit ' + value,
          authorName: 'Fixture author',
          authorEmail: 'fixture@example.test',
          authorDate: null,
          commitDate: null,
        })),
        annotations: { user: null, currentBranch: [] },
      },
    });
    window.addEventListener(
      'finish-enrichment',
      () =>
        send({
          kind: 'history-enrichment',
          enrichment: {
            scopeId: 'fresh',
            shas: [sha(1), sha(2)],
            refs: refs.map((ref) => ({
              ...ref,
              tracking: {
                upstream: 'refs/remotes/origin/main',
                ahead: 0,
                behind: 3,
              },
            })),
            annotations: {
              user: { name: '', email: 'fixture@example.test' },
              currentBranch: [sha(1)],
            },
          },
        }),
      { once: true },
    );
  });
  const row = page.locator('[data-commit-row]').first();
  const pane = page.locator('#history-pane');

  await expect(pane).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#history')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-incoming]')).toHaveCount(0);
  await expect(row.locator('[data-author]')).toHaveCSS('font-weight', '400');
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  const bounds = await row.boundingBox();

  await page.evaluate(() =>
    window.dispatchEvent(new Event('finish-enrichment')),
  );
  await expect(page.locator('[data-incoming]')).toHaveText('3');
  await expect(row.locator('[data-author]')).toHaveCSS('font-weight', '600');
  await expect(row).toHaveAccessibleDescription(
    'Current checkout. Your commit. Current branch',
  );
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(pane).toHaveAttribute('aria-busy', 'false');
  expect(await row.boundingBox()).toEqual(bounds);
});
