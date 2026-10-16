import type { SourceControlState } from '../../src/shared/source-control';
import { expect, type Page, test } from '../fixtures/browser';

async function showFiles(page: Page, count: number) {
  await page.goto('/');
  await page.locator('[data-commit-row]').first().click();
  await page.evaluate((count) => {
    const request = window.__requests.at(-1)!;
    const sha = '1'.padStart(40, '0');
    const parent = 'a'.repeat(40);

    window.__deliver({
      ...request,
      body: {
        kind: 'details',
        commit: {
          sha,
          parents: [parent],
          message: 'Large file fixture',
          authorName: 'Fixture',
          authorEmail: 'fixture@example.test',
          authorDate: '2026-10-16T00:00:00Z',
          commitDate: '2026-10-16T00:00:00Z',
        },
      },
    });
    window.__deliver({
      ...request,
      body: {
        kind: 'files',
        sha,
        parentSha: parent,
        files: Array.from({ length: count }, (_, index) => ({
          id: String(index),
          status: 'modified',
          oldPath: `src/file-${String(index).padStart(5, '0')}.ts`,
          newPath: `src/file-${String(index).padStart(5, '0')}.ts`,
        })),
      },
    });
  }, count);
}

test('large changed-file trees bound mounted rows and navigate offscreen with native menu targets', async ({
  page,
}) => {
  await showFiles(page, 10000);
  const tree = page.locator('#files');
  const first = tree.locator('[data-file="0"]');

  await expect(first).toBeVisible();
  expect(await tree.locator('[data-tree-row-key]').count()).toBeLessThan(100);
  await first.click();
  await page.keyboard.press('Shift+End');
  const last = tree.locator('[data-file="9999"]');

  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await page.keyboard.press('Shift+F10');
  expect(
    JSON.parse((await last.getAttribute('data-vscode-context'))!),
  ).toMatchObject({ fileId: '9999', fileSelectionCount: 10000 });
  await page.keyboard.press('Home');
  await expect(tree.locator(':scope > details > summary')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const folder = tree.getByRole('treeitem', {
    name: 'src 10000 files',
    exact: true,
  });

  await expect(folder).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tree.locator('[data-file]')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeVisible();
});

test('host selection reveals an offscreen file in the existing scroll owner', async ({
  page,
}) => {
  await showFiles(page, 10000);
  await page.evaluate(() => {
    const request = window.__requests.at(-1)!;

    window.__deliver({
      ...request,
      body: {
        kind: 'selection',
        sha: '1'.padStart(40, '0'),
        parentSha: 'a'.repeat(40),
        filePath: 'src/file-09999.ts',
        anchor: { sha: '1'.padStart(40, '0'), offset: 0 },
      },
    });
  });
  const last = page.locator('#files [data-file="9999"]');

  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(last).toBeInViewport();
  expect(
    await page.locator('#files').evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(200000);
  expect(await page.locator('#files [data-tree-row-key]').count()).toBeLessThan(
    100,
  );
});

async function largeSourceState(page: Page) {
  await page.goto('/source-control.html');
  const state = await page.evaluate(() => {
    const sha = 'a'.repeat(40);
    const files = Array.from({ length: 10000 }, (_, index) => ({
      path: `src/file-${String(index).padStart(5, '0')}.ts`,
      originalPath: `src/file-${String(index).padStart(5, '0')}.ts`,
      status: ' M',
      staged: false,
      working: true,
      untracked: false,
    }));
    const state = {
      hoverDelay: 700,
      repositoryId: 'repo',
      tab: 'commit',
      busy: false,
      generating: false,
      reveal: null,
      repositories: [
        {
          info: {
            id: 'repo',
            label: 'Example repository',
            rootUri: 'file:///example',
            headSha: sha,
            branch: 'main',
          },
          pathLabel: { root: '~/projects/example', separator: '/' },
          checked: [],
          draft: '',
          draftEditId: null,
          operation: { kind: 'ready', items: [] },
          commitMode: { kind: 'new' },
          changes: { kind: 'ready', items: files },
          stashes: {
            kind: 'ready',
            items: [
              {
                sha,
                viewId: sha,
                base: sha,
                date: '2026-10-10T00:00:00Z',
                selector: 'stash@{0}',
                message: 'Example stash',
                files: {
                  kind: 'ready',
                  items: [
                    {
                      path: 'header.ts',
                      originalPath: 'header.ts',
                      status: 'M',
                      snapshot: 'index',
                      oldRef: sha,
                      newRef: sha,
                      deleted: false,
                    },
                    ...files.map((file) => ({
                      path: file.path,
                      originalPath: file.path,
                      status: 'M',
                      snapshot: 'working' as const,
                      oldRef: sha,
                      newRef: sha,
                      deleted: false,
                    })),
                  ],
                },
              },
            ],
          },
        },
      ],
    } satisfies SourceControlState;

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'source-control-state', state },
      }),
    );

    return state;
  });

  return state;
}

test('Changes reuses its scroll owner for offscreen focus, folder inclusion and synchronous menu targets', async ({
  page,
}) => {
  const state = await largeSourceState(page);
  const tree = page.getByRole('tree', { name: 'Changes', exact: true });
  const folder = tree.getByRole('treeitem', { name: 'src', exact: true });

  await expect(folder).toBeVisible();
  expect(await tree.locator('[data-tree-row-key]').count()).toBeLessThan(100);
  await folder.getByRole('checkbox').click();
  await expect(folder.getByRole('checkbox')).toBeChecked();
  const requests: unknown = await page.evaluate(() =>
    Reflect.get(window, 'sourceControlRequests'),
  );

  expect(requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'check',
        checked: true,
        paths: expect.arrayContaining([
          'src/file-00000.ts',
          'src/file-09999.ts',
        ]),
      }),
    ]),
  );
  await page.evaluate((state) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          kind: 'source-control-state',
          state: {
            ...state,
            reveal: {
              repositoryId: 'repo',
              path: 'src/file-09999.ts',
              sequence: 1,
            },
          },
        },
      }),
    );
  }, state);
  const last = tree.locator('[data-path="src/file-09999.ts"]');

  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await page.keyboard.press('Shift+F10');
  expect(
    JSON.parse((await last.getAttribute('data-vscode-context'))!),
  ).toMatchObject({ paths: ['src/file-09999.ts'], changeSelectionCount: 1 });
  expect(
    await tree.evaluate((node) => ({
      own: getComputedStyle(node).overflowY,
      parent: node.parentElement?.scrollTop,
    })),
  ).toMatchObject({ own: 'visible', parent: expect.any(Number) });
  expect(await tree.locator('[data-tree-row-key]').count()).toBeLessThan(100);
});

test('Stash snapshot trees share one scroller and navigate beyond the mounted window', async ({
  page,
}) => {
  await largeSourceState(page);
  await page.getByRole('tab', { name: 'Stashes', exact: true }).click();
  await page.getByRole('button', { name: /Expand Example stash/ }).click();
  const tree = page.getByRole('tree', { name: 'Working files', exact: true });
  const first = tree.locator('[data-path="src/file-00000.ts"]');

  await expect(first).toBeVisible();
  await first.click();
  await page.keyboard.press('End');
  const last = tree.locator('[data-path="src/file-09999.ts"]');

  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await last.click({ button: 'right' });
  expect(
    JSON.parse((await last.getAttribute('data-vscode-context'))!),
  ).toMatchObject({
    files: [{ path: 'src/file-09999.ts', snapshot: 'working' }],
  });
  expect(await tree.locator('[data-tree-row-key]').count()).toBeLessThan(100);
  expect(await tree.evaluate((node) => getComputedStyle(node).overflowY)).toBe(
    'visible',
  );
});

test('collapsing a preceding merge comparison fills the next tree viewport without scrolling', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-commit-row]').first().click();
  await page.evaluate(() => {
    const request = window.__requests.at(-1)!;
    const sha = '1'.padStart(40, '0');
    const parents = ['a'.repeat(40), 'b'.repeat(40)];

    window.__deliver({
      ...request,
      body: {
        kind: 'details',
        commit: {
          sha,
          parents,
          message: 'Large merge',
          authorName: null,
          authorEmail: null,
          authorDate: null,
          commitDate: null,
        },
      },
    });
    for (const [index, parentSha] of parents.entries()) {
      window.__deliver({
        ...request,
        body: {
          kind: 'files',
          sha,
          parentSha,
          files: Array.from({ length: 1000 }, (_, file) => ({
            id: `${index}-${file}`,
            status: 'modified',
            oldPath: `src/file-${String(file).padStart(4, '0')}.ts`,
            newPath: `src/file-${String(file).padStart(4, '0')}.ts`,
          })),
        },
      });
    }
  });
  const files = page.locator('#files');
  const firstHeader = files.getByRole('treeitem', {
    name: /Changes to Parent 1/,
  });
  const secondHeader = files.getByRole('treeitem', {
    name: /Changes to Parent 2/,
  });

  // Open below the viewport without an incidental scroll/reset callback that
  // could hide stale measurements when the first comparison later collapses.
  await secondHeader.dispatchEvent('click');
  await expect(secondHeader).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(firstHeader).toBeInViewport();
  await firstHeader.click();
  await expect(firstHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(files.locator('[data-file="1-10"]')).toBeInViewport();
  expect(await files.evaluate((node) => node.scrollTop)).toBe(0);
  expect(await files.locator('[data-tree-row-key]').count()).toBeLessThan(100);
});

test('ArrowLeft from a collapsed top-level folder focuses its comparison without reopening it', async ({
  page,
}) => {
  await showFiles(page, 10);
  const files = page.locator('#files');
  const folder = files.getByRole('treeitem', {
    name: 'src 10 files',
    exact: true,
  });
  const header = files.locator(':scope > details > summary');

  await folder.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowLeft');
  await expect(header).toBeFocused();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await expect(files.locator('[data-file]')).toHaveCount(0);
});

test('each Changes snapshot reveals its own final row inside the shared scroll owner', async ({
  page,
}) => {
  const state = await largeSourceState(page);

  await page.evaluate((state) => {
    const repository = state.repositories[0]!;

    if (repository.changes.kind !== 'ready')
      throw new Error('Missing fixture changes');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          kind: 'source-control-state',
          state: {
            ...state,
            repositories: [
              {
                ...repository,
                changes: {
                  kind: 'ready',
                  items: repository.changes.items.map((file, index) =>
                    index < 100
                      ? { ...file, status: 'M ', staged: true, working: false }
                      : file,
                  ),
                },
              },
            ],
          },
        },
      }),
    );
  }, state);
  const staged = page.getByRole('tree', {
    name: 'Staged Changes',
    exact: true,
  });
  const root = staged.locator('[data-root]');

  await root.focus();
  await root.press('End');
  const last = staged.getByRole('treeitem', {
    name: 'src/file-00099.ts',
    exact: true,
  });

  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  expect(await page.locator('[data-tree-row-key]').count()).toBeLessThan(100);
});
