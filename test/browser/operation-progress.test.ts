import { expect, test } from '../fixtures/browser';

test('interrupting a refresh keeps the last graph visible without leaving its progress line running', async ({
  page,
}) => {
  await page.goto('/');
  const rows = page.locator('[data-commit-row]');

  await expect(rows.first()).toBeVisible();
  const count = await rows.count();

  await page.evaluate(() => {
    const repository = {
      id: 'one',
      label: 'Example',
      rootUri: 'file:///example',
      branch: 'main',
      headSha: '1'.padStart(40, '0'),
    };

    window.__deliver({
      requestId: 'first-refresh',
      repositoryId: 'one',
      generation: 2,
      body: {
        kind: 'loading',
        repository,
        preserve: true,
        scope: { kind: 'head' },
        text: '',
      },
    });
  });
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await page.evaluate(() => {
    window.__deliver({
      requestId: 'second-write',
      repositoryId: 'one',
      generation: 2,
      body: { kind: 'history-interrupted' },
    });
    window.__deliver({
      requestId: 'second-write',
      repositoryId: 'one',
      generation: 2,
      body: {
        kind: 'operation-progress',
        operation: {
          label: 'Updating main…',
          refIds: ['refs/heads/main'],
          section: 'branches',
          phase: 'running',
        },
      },
    });
  });
  await expect(rows).toHaveCount(count);
  await expect(page.locator('#history')).toHaveAttribute('inert', '');
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    page.locator('#history-pane > [aria-hidden="true"]'),
  ).toHaveCount(0);
  await expect(page.locator('#status')).not.toContainText('No commits');
  await expect(
    page.locator('[data-ref="refs/heads/main"] .codicon-loading'),
  ).toBeVisible();
  await page.evaluate(() => {
    const repository = {
      id: 'one',
      label: 'Example',
      rootUri: 'file:///example',
      branch: 'main',
      headSha: '1'.padStart(40, '0'),
    };

    window.__deliver({
      requestId: 'fresh-history',
      repositoryId: 'one',
      generation: 3,
      body: {
        kind: 'history',
        repository,
        scope: { kind: 'head' },
        text: '',
        append: false,
        page: { commits: [], refs: [], nextCursor: null, scopeId: 'empty' },
      },
    });
  });
  await expect(rows).toHaveCount(0);
  await expect(page.locator('#history')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#status')).toHaveText(
    'No commits in these results.',
  );
});

test('deletion removes the branch while the graph is still refreshing', async ({
  page,
}) => {
  await page.goto('/');
  const topic = page.locator('[data-ref="refs/heads/topic"]');

  await expect(topic).toBeVisible();
  const count = await page.locator('[data-commit-row]').count();

  await page.evaluate(() =>
    window.__deliver({
      requestId: 'delete-topic',
      repositoryId: 'one',
      generation: 1,
      body: {
        kind: 'operation-progress',
        operation: {
          label: 'Deleting topic…',
          refIds: ['refs/heads/topic'],
          phase: 'running',
        },
      },
    }),
  );
  await expect(topic.getByLabel('Deleting topic…')).toBeVisible();
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator('#fetch')).toBeEnabled();
  const context = JSON.parse(
    (await topic.getAttribute('data-vscode-context'))!,
  );

  expect(context.logOperationBusy).toBe(true);
  await page.evaluate(() => {
    window.__deliver({
      requestId: 'delete-topic',
      repositoryId: 'one',
      generation: 1,
      body: {
        kind: 'operation-progress',
        operation: {
          label: 'Deleting topic…',
          refIds: ['refs/heads/topic'],
          phase: 'refreshing',
        },
      },
    });
    window.__deliver({
      requestId: 'refresh',
      repositoryId: 'one',
      generation: 1,
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
    });
    window.__deliver({
      requestId: 'references',
      repositoryId: 'one',
      generation: 1,
      body: {
        kind: 'references',
        references: [
          {
            id: 'refs/heads/main',
            name: 'main',
            kind: 'local',
            sha: '1'.padStart(40, '0'),
            remote: null,
          },
        ],
      },
    });
  });
  await expect(topic).toHaveCount(0);
  await expect(page.locator('[data-commit-row]')).toHaveCount(count);
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(page.getByRole('status')).toHaveText('Refreshing history…');
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'delete-topic',
      repositoryId: 'one',
      generation: 1,
      body: { kind: 'operation-progress', operation: null },
    }),
  );
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'refresh',
      repositoryId: 'one',
      generation: 1,
      body: { kind: 'history-settled' },
    }),
  );
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator('#fetch')).toBeEnabled();
});

test('checkout updates branch names and current checkout before the graph arrives', async ({
  page,
}) => {
  await page.goto('/');
  const count = await page.locator('[data-commit-row]').count();

  await page.evaluate(() => {
    const repository = {
      id: 'one',
      label: 'Example',
      rootUri: 'file:///example',
      branch: 'new-branch',
      headSha: '1'.padStart(40, '0'),
    };

    window.__deliver({
      requestId: 'create',
      repositoryId: 'one',
      generation: 1,
      body: {
        kind: 'operation-progress',
        operation: {
          label: 'Creating and checking out branch…',
          refIds: ['refs/heads/main'],
          phase: 'refreshing',
        },
      },
    });
    window.__deliver({
      requestId: 'refresh',
      repositoryId: 'one',
      generation: 2,
      body: {
        kind: 'loading',
        repository,
        preserve: true,
        scope: { kind: 'head' },
        text: '',
      },
    });
    window.__deliver({
      requestId: 'refresh',
      repositoryId: 'one',
      generation: 2,
      body: {
        kind: 'references',
        repository,
        references: ['main', 'new-branch'].map((name) => ({
          id: `refs/heads/${name}`,
          name,
          kind: 'local',
          sha: repository.headSha,
          remote: null,
        })),
      },
    });
  });
  await expect(
    page.locator('[data-current="true"] [data-reference-name]'),
  ).toHaveText('new-branch');
  await expect(page.locator('#scope')).toHaveText('new-branch');
  await expect(page.locator('[data-commit-row]')).toHaveCount(count);
  await expect(page.locator('[data-commit-row]').first()).toContainText(
    'new-branch',
  );
  await expect(page.locator('#history-pane')).toHaveAttribute(
    'aria-busy',
    'true',
  );
});

test('worktree Git progress is visible in Worktrees while actions remain available', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Worktrees', exact: true }).click();
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'create-worktree',
      repositoryId: 'one',
      generation: 1,
      body: {
        kind: 'operation-progress',
        operation: {
          label: 'Creating worktree…',
          refIds: [],
          section: 'worktrees',
          phase: 'running',
        },
      },
    }),
  );
  await expect(page.locator('#worktrees-view')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(
    page.locator('#worktrees-view > [aria-hidden="true"]'),
  ).toHaveCSS('height', '2px');
  await expect(
    page.getByRole('button', { name: 'Create Worktree', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText('Creating worktree…');
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'create-worktree',
      repositoryId: 'one',
      generation: 1,
      body: { kind: 'operation-progress', operation: null },
    }),
  );
  await expect(
    page.getByRole('button', { name: 'Create Worktree', exact: true }),
  ).toBeEnabled();
});
