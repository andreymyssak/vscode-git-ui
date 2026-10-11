import { updateReferences } from '../fixtures/branch-references';
import { expect, test } from '../fixtures/browser';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 360 });
  await page.goto('/');
});

for (const path of ['/', '/development.html']) {
  test(`reveal current branch clears search and centers its path while preserving selection, ${path}`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(page.locator('[data-commit-row]').first()).toBeVisible();
    const generation = JSON.parse(
      (await page
        .locator('[data-ref]')
        .first()
        .getAttribute('data-vscode-context'))!,
    ).generation as number;
    const locals = [
      ...Array.from({ length: 80 }, (_, index) => `folder-${index}/other`),
      'topic',
      'zz/deep/current',
      ...Array.from({ length: 40 }, (_, index) => `zzz-${index}/other`),
    ];

    await updateReferences(
      page,
      locals,
      '1'.padStart(40, '0'),
      'zz/deep/current',
      'one',
      generation,
    );
    const topic = page.getByRole('treeitem', { name: 'topic', exact: true });

    await topic.click();
    const local = page.getByRole('treeitem', { name: 'Local', exact: true });

    await local.focus();
    await local.press('ArrowLeft');
    await expect(local).toHaveAttribute('aria-expanded', 'false');
    const search = page.getByRole('searchbox', { name: 'Branch or tag' });

    await search.fill('folder-1');
    const before = await page.evaluate(() => window.__requests.length);
    const reveal = page.getByRole('button', {
      name: 'Reveal Current Branch',
      exact: true,
    });

    await reveal.click();
    const current = page.getByRole('treeitem', {
      name: 'current (Current branch)',
      exact: true,
    });

    await expect(search).toHaveValue('');
    await expect(reveal).toBeFocused();
    await expect(topic).toHaveAttribute('aria-selected', 'true');
    await expect(current).toHaveAttribute('aria-selected', 'false');
    for (const name of ['zz', 'deep'])
      await expect(
        page.getByRole('treeitem', { name, exact: true }),
      ).toHaveAttribute('aria-expanded', 'true');
    const tree = page.getByRole('tree', { name: 'References' });

    await expect(current).toBeInViewport({ ratio: 1 });
    const bounds = (await tree.boundingBox())!;

    await expect
      .poll(async () => {
        const row = (await current.boundingBox())!;

        return Math.abs(row.y + row.height / 2 - bounds.y - bounds.height / 2);
      })
      .toBeLessThan(2);
    expect(await page.evaluate(() => window.__requests.length)).toBe(before);
    await tree.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    });
    await updateReferences(
      page,
      ['main'],
      '2'.padStart(40, '0'),
      'main',
      'two',
      generation + 1,
    );
    await expect(
      page.getByRole('treeitem', {
        name: 'main (Current branch)',
        exact: true,
      }),
    ).toBeVisible();
    await updateReferences(
      page,
      locals,
      '1'.padStart(40, '0'),
      'zz/deep/current',
      'one',
      generation + 2,
    );
    await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(0);
    await reveal.click();
    await expect(current).toBeInViewport({ ratio: 1 });
    await updateReferences(
      page,
      ['topic'],
      '1'.padStart(40, '0'),
      null,
      'one',
      generation + 2,
    );
    await expect(reveal).toBeDisabled();
  });
}

test('first opening shows only the current local path and selects its branch', async ({
  page,
}) => {
  await expect(
    page.getByRole('treeitem', { name: 'All branches', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('treeitem', { name: 'Local', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  for (const name of ['Remote', 'Tags', 'feature'])
    await expect(
      page.getByRole('treeitem', { name, exact: true }),
    ).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('treeitem', { name: 'main (Current branch)', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#scope')).toHaveText('main');
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (request) =>
        request.body.kind === 'action' || request.body.kind === 'history',
    ),
  ).toHaveLength(0);
});

test('hundreds of branch names stay grouped and reveal the searched branch for activation', async ({
  page,
}) => {
  await updateReferences(page, [
    'main',
    ...Array.from({ length: 500 }, (_, index) => `feature-${index}/task`),
  ]);
  const folder = page.getByRole('treeitem', {
    name: 'feature-499',
    exact: true,
  });

  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await page
    .getByRole('searchbox', { name: 'Branch or tag' })
    .fill('feature-499/task');
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('treeitem', { name: 'task', exact: true }).dblclick();
  expect(
    (await page.evaluate(() => window.__requests)).some(
      ({ body }) =>
        body.kind === 'history' &&
        body.scope.kind === 'ref' &&
        body.scope.refId === 'refs/heads/feature-499/task',
    ),
  ).toBe(true);
});

test('a nested current branch opens only its own path by default', async ({
  page,
}) => {
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/?current=feature/team/current');
  for (const name of ['Local', 'feature', 'team'])
    await expect(
      page.getByRole('treeitem', { name, exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('treeitem', {
      name: 'current (Current branch)',
      exact: true,
    }),
  ).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Remote', 'Tags'])
    await expect(
      page.getByRole('treeitem', { name, exact: true }),
    ).toHaveAttribute('aria-expanded', 'false');
});

test('the current branch name stays readable in a narrow pane', async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 280 });
  const current = page.locator('[data-current="true"]');

  await expect(current).toBeVisible();
  expect(
    (await current.locator('[data-reference-name]').boundingBox())!.width,
  ).toBeGreaterThanOrEqual(25);
  await expect(current).toHaveAttribute('title', 'main');
});

test('Tab visits branch actions then the tree after searching and clearing', async ({
  page,
}) => {
  const search = page.getByRole('searchbox', { name: 'Branch or tag' });

  await search.fill('feature');
  await expect(
    page.getByRole('treeitem', { name: 'nested', exact: true }),
  ).toBeVisible();
  await search.press('Tab');
  await expect(
    page.getByRole('button', {
      name: 'Reveal Current Branch',
      exact: true,
    }),
  ).toBeFocused();
  for (const name of ['Fetch All Remotes']) {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
  }

  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('treeitem', { name: 'Local', exact: true }),
  ).toBeFocused();
  await search.focus();
  await search.press('Escape');
  await expect(
    page.getByRole('treeitem', { name: 'topic', exact: true }),
  ).toBeVisible();
  const current = page.getByRole('treeitem', {
    name: 'main (Current branch)',
    exact: true,
  });

  // The custom tree restores its keyboard entry point after rendering the rows.
  await expect(current).toHaveAttribute('tabindex', '0');
  await search.press('Tab');
  await expect(
    page.getByRole('button', {
      name: 'Reveal Current Branch',
      exact: true,
    }),
  ).toBeFocused();
  for (const name of ['Fetch All Remotes']) {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
  }

  await page.keyboard.press('Tab');
  await expect(current).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('button', { name: 'Fetch All Remotes', exact: true }),
  ).toBeFocused();
});

test('deep reference paths retain readable names and horizontal scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 280 });
  await expect(page.locator('#branch-pane')).toHaveCSS('width', '150px');
  await updateReferences(page, ['main', 'feature/team/epic/deep-reference']);
  await page.getByRole('searchbox', { name: 'Branch or tag' }).fill('feature');
  const leaf = page.getByRole('treeitem', {
    name: 'deep-reference',
    exact: true,
  });

  await expect(leaf).toBeVisible();
  expect(
    (await leaf.locator('[data-reference-name]').boundingBox())!.width,
  ).toBeGreaterThanOrEqual(40);
  const tree = page.getByRole('tree', { name: 'References' });

  await tree.evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
  });
  await expect(leaf.locator('[data-reference-name]')).toBeInViewport({
    ratio: 1,
  });
  await leaf.locator('[data-reference-name]').click();
  await expect(leaf).toHaveAttribute('aria-selected', 'true');
  await expect(leaf).toHaveAttribute(
    'title',
    'feature/team/epic/deep-reference',
  );
});

test('reference refresh preserves scroll and keyboard focus in a long tree', async ({
  page,
}) => {
  const branches = [
    'main',
    ...Array.from({ length: 100 }, (_, index) => 'branch' + index),
  ];

  await updateReferences(page, branches);
  const branch = page.getByRole('treeitem', { name: 'branch50', exact: true });

  await branch.click();
  await branch.focus();
  const tree = page.getByRole('tree', { name: 'References' });
  const before = await tree.evaluate((node) => node.scrollTop);

  expect(before).toBeGreaterThan(500);
  await updateReferences(page, branches, '2'.repeat(40));
  await expect(branch).toBeFocused();
  expect(await tree.evaluate((node) => node.scrollTop)).toBe(before);
  await expect(branch).toHaveAttribute('aria-selected', 'true');
  await branch.press('ArrowDown');
  await expect(
    page.getByRole('treeitem', { name: 'branch51', exact: true }),
  ).toBeFocused();
});

test('keyboard navigation reveals deep reference names in a narrow pane', async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 280 });
  await expect(page.locator('#branch-pane')).toHaveCSS('width', '150px');
  await updateReferences(page, ['main', 'feature/team/epic/deep-reference']);
  const search = page.getByRole('searchbox', { name: 'Branch or tag' });

  await search.fill('feature');
  await expect(
    page.getByRole('treeitem', { name: 'deep-reference', exact: true }),
  ).toBeVisible();
  await search.press('ArrowDown');
  for (let index = 0; index < 4; index++)
    await page.keyboard.press('ArrowDown');
  const leaf = page.getByRole('treeitem', {
    name: 'deep-reference',
    exact: true,
  });

  await expect(leaf).toBeFocused();
  await expect(leaf.locator('[data-reference-name]')).toBeInViewport({
    ratio: 1,
  });
});

test('pending filter layout preserves scrolling to the focused branch name', async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 280 });
  await expect(page.locator('#branch-pane')).toHaveCSS('width', '150px');
  await updateReferences(page, ['main', 'feature/team/epic/deep-reference']);
  const finishLayout = await page.evaluateHandle(() => {
    const request = window.requestAnimationFrame;
    const pending: FrameRequestCallback[] = [];

    window.requestAnimationFrame = (callback) => pending.push(callback);

    return async () => {
      const tree = document.getElementById('branches');

      if (!tree) throw new Error('Branch tree must be available.');
      for (let step = 0; step < 5; step++) {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
        for (const item of tree.querySelectorAll('vscode-tree-item'))
          await item.updateComplete;
      }

      window.requestAnimationFrame = request;
      for (const callback of pending) callback(performance.now());
    };
  });

  await page.getByRole('searchbox', { name: 'Branch or tag' }).fill('feature');
  const leaf = page.getByRole('treeitem', {
    name: 'deep-reference',
    exact: true,
  });

  await expect(leaf).toBeVisible();
  await finishLayout.evaluate((finish) => finish());
  await finishLayout.dispose();
  await expect(leaf).toBeFocused();
  await expect(leaf.locator('[data-reference-name]')).toBeInViewport({
    ratio: 1,
  });
});

test('pending filter layout preserves horizontal scrolling before its scroll event', async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 280 });
  await expect(page.locator('#branch-pane')).toHaveCSS('width', '150px');
  await updateReferences(page, ['main', 'feature/team/epic/deep-reference']);
  const finishLayout = await page.evaluateHandle(() => {
    const request = window.requestAnimationFrame;
    const pending: FrameRequestCallback[] = [];

    window.requestAnimationFrame = (callback) => pending.push(callback);

    return async () => {
      const tree = document.getElementById('branches');

      if (!tree) throw new Error('Branch tree must be available.');
      for (const item of tree.querySelectorAll('vscode-tree-item'))
        await item.updateComplete;
      if (!pending.length)
        throw new Error('Layout restoration must be pending.');
      tree.scrollLeft = tree.scrollWidth;
      const intended = tree.scrollLeft;

      window.requestAnimationFrame = request;
      for (const callback of pending) callback(performance.now());

      return intended;
    };
  });

  await page.getByRole('searchbox', { name: 'Branch or tag' }).fill('feature');
  const leaf = page.getByRole('treeitem', {
    name: 'deep-reference',
    exact: true,
  });

  await expect(leaf).toBeVisible();
  const intended = await finishLayout.evaluate((finish) => finish());

  await finishLayout.dispose();
  expect(intended).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page
        .getByRole('tree', { name: 'References' })
        .evaluate((node) => node.scrollLeft),
    )
    .toBe(intended);
  await expect(leaf.locator('[data-reference-name]')).toBeInViewport({
    ratio: 1,
  });
});

test('removing the focused reference keeps keyboard navigation in the tree', async ({
  page,
}) => {
  const topic = page.getByRole('treeitem', { name: 'topic', exact: true });

  await topic.click();
  await topic.focus();
  await updateReferences(page, ['main']);
  await expect(
    page.getByRole('treeitem', { name: 'All branches', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('treeitem', { name: 'HEAD (Current Branch)', exact: true }),
  ).toBeFocused();
});

test('branch search reveals matching paths without changing history or checkout', async ({
  page,
}) => {
  const feature = page.getByRole('treeitem', { name: 'feature', exact: true });

  await expect(feature).toHaveAttribute('aria-expanded', 'false');
  const search = page.getByRole('searchbox', { name: 'Branch or tag' });

  await search.fill('FEATURE/NEST');
  await expect(
    page.getByRole('treeitem', { name: 'nested', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('treeitem', { name: 'topic', exact: true }),
  ).toBeHidden();
  await expect(page.locator('#scope')).toHaveText('main');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(feature).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('treeitem', { name: 'topic', exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (request) =>
        request.body.kind === 'history' || request.body.kind === 'action',
    ),
  ).toHaveLength(0);
});

test('changed references preserve expanded folders and collapsed groups', async ({
  page,
}) => {
  const feature = page.getByRole('treeitem', { name: 'feature', exact: true });
  const remote = page.getByRole('treeitem', { name: 'Remote', exact: true });

  await feature.click();
  await remote.locator(':scope > [data-reference-name]').click();
  await expect(remote).toHaveAttribute('aria-expanded', 'true');
  await remote.locator(':scope > [data-reference-name]').click();
  await expect(feature).toHaveAttribute('aria-expanded', 'true');
  await expect(remote).toHaveAttribute('aria-expanded', 'false');
  await updateReferences(page);
  await expect(feature).toHaveAttribute('aria-expanded', 'true');
  await expect(remote).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('treeitem', { name: 'nested', exact: true }),
  ).toBeVisible();
});

test('searching tags has a stable empty state and restores the previous tree', async ({
  page,
}) => {
  await updateReferences(page);
  const tags = page.getByRole('treeitem', { name: 'Tags', exact: true });

  await tags.locator(':scope > [data-reference-name]').click();
  const search = page.getByRole('searchbox', { name: 'Branch or tag' });
  const panes = async () =>
    Promise.all(
      ['#branch-pane', '#history-pane', '#details'].map((id) =>
        page.locator(id).boundingBox(),
      ),
    );
  const before = await panes();

  await search.fill('@wk/api_v2.1.1');
  await expect(
    page.getByRole('treeitem', { name: 'api_v2.1.1', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('treeitem', { name: 'api_v2.1.0', exact: true }),
  ).toBeHidden();
  await search.fill('missing-tag');
  await expect(
    page.getByText('No matching branches or tags.', { exact: true }),
  ).toBeVisible();
  expect(await panes()).toEqual(before);
  await search.press('Escape');
  await expect(tags).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('treeitem', { name: '@wk', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  expect(await panes()).toEqual(before);
});

test('obsolete tree restoration cannot steal the new repository viewport', async ({
  page,
}) => {
  await page.getByRole('treeitem', { name: 'topic', exact: true }).focus();
  await page.evaluate(() => {
    const pending = new Promise<boolean>((resolve) =>
      Reflect.set(window, 'releaseOldTree', () => resolve(true)),
    );

    Reflect.set(window, 'oldTreeUpdate', pending);
    Object.defineProperty(
      document.getElementById('branches')!,
      'updateComplete',
      { configurable: true, get: () => pending },
    );
  });
  await updateReferences(page, ['main', 'topic', 'extra']);
  await page.evaluate(() => {
    const repository = {
      id: 'two',
      label: 'Second',
      rootUri: 'file:///second',
      branch: 'fresh',
      headSha: 'a'.repeat(40),
    };

    window.__deliver({
      requestId: 'switch',
      repositoryId: 'two',
      generation: 2,
      body: { kind: 'loading', repository, scope: { kind: 'head' }, text: '' },
    });
    window.__deliver({
      requestId: 'switch',
      repositoryId: 'two',
      generation: 2,
      body: {
        kind: 'history',
        repository,
        scope: { kind: 'head' },
        text: '',
        append: false,
        page: {
          commits: [],
          refs: [
            {
              id: 'refs/heads/fresh',
              name: 'fresh',
              sha: repository.headSha,
              kind: 'local',
              remote: null,
            },
          ],
          scopeId: 'two',
          nextCursor: null,
        },
      },
    });
  });
  const fresh = page.getByRole('treeitem', {
    name: 'fresh (Current branch)',
    exact: true,
  });

  await fresh.focus();
  await page.evaluate(async () => {
    const oldUpdate = Reflect.get(window, 'oldTreeUpdate') as Promise<boolean>;

    (Reflect.get(window, 'releaseOldTree') as () => void)();
    await oldUpdate;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  await expect(fresh).toBeFocused();
  await expect(
    page.getByRole('treeitem', { name: 'Local', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await fresh.press('Shift+F10');
  await expect(fresh).toHaveAttribute(
    'data-vscode-context',
    /"repositoryId":"two"/,
  );
  await expect(fresh).toHaveAttribute('data-vscode-context', /"generation":2/);
});

test('branch gutters stay compact and fixed before and after references load', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__deliver({
      requestId: 'switch',
      repositoryId: 'one',
      generation: 1,
      body: {
        kind: 'history',
        repository: {
          id: 'one',
          label: 'Example',
          rootUri: 'file:///example',
          branch: 'main',
          headSha: '1'.padStart(40, '0'),
        },
        scope: { kind: 'head' },
        text: '',
        append: false,
        page: { commits: [], refs: [], nextCursor: null, scopeId: 'empty' },
      },
    });
  });
  const local = page.locator('[data-tree-node="group:local"]');
  const before = await local
    .locator(':scope > [data-reference-name]')
    .boundingBox();

  await updateReferences(page);
  await expect(local).toHaveAttribute('aria-expanded', 'true');
  const after = await local
    .locator(':scope > [data-reference-name]')
    .boundingBox();

  expect(after!.x).toBe(before!.x);
  expect(after!.height).toBe(22);
  const tree = await page.locator('#branches').boundingBox();

  expect(after!.x - tree!.x).toBe(30);
  const branch = await page
    .locator('[data-current="true"] [data-reference-name]')
    .boundingBox();

  expect(branch!.x - after!.x).toBe(30);
});
