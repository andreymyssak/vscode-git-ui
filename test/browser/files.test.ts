import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/browser';
import { changedFiles } from '../fixtures/changed-files';

async function showChangedFiles(page: Page, files = changedFiles) {
  await page.goto('/');
  await page.locator('[data-commit-row]').first().click();
  await page.evaluate((files) => {
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
          message: 'Update README.md and bump project scripts',
          authorName: 'Fixture author',
          authorEmail: 'fixture@example.test',
          authorDate: '2026-08-17T14:28:00Z',
          commitDate: '2026-08-20T12:19:00Z',
        },
      },
    });
    window.__deliver({
      ...request,
      body: { kind: 'files', sha, parentSha: parent, files },
    });
  }, files);
}

test('Log folders show themed status dots while counts stay beside the label', async ({
  page,
}) => {
  await showChangedFiles(page, [
    ...changedFiles,
    {
      id: 'deleted-folder-file',
      status: 'deleted',
      oldPath: 'removed/old.ts',
      newPath: null,
    },
  ]);
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      '--vscode-gitDecoration-modifiedResourceForeground',
      '#73b4ff',
    );
    document.documentElement.style.setProperty(
      '--vscode-gitDecoration-renamedResourceForeground',
      '#73c991',
    );
  });
  const common = page.getByRole('treeitem', { name: 'common 4 files' });
  const renamed = page.getByRole('treeitem', {
    name: 'packages/api/src 1 file',
  });
  const removed = page.getByRole('treeitem', { name: 'removed 1 file' });

  await expect(common.locator('[data-folder-status]')).toBeVisible();
  await expect(common.locator('[data-folder-status]')).toHaveCSS(
    'color',
    'rgb(115, 180, 255)',
  );
  await expect(renamed.locator('[data-folder-status]')).toHaveCSS(
    'color',
    'rgb(115, 201, 145)',
  );
  await expect(removed.locator('[data-folder-status]')).toHaveCount(0);
  const label = (await common
    .getByText('common', { exact: true })
    .boundingBox())!;
  const count = (await common
    .getByText('4 files', { exact: true })
    .boundingBox())!;
  const dot = (await common.locator('[data-folder-status]').boundingBox())!;

  expect(count.x - label.x - label.width).toBe(6);
  expect(dot.x).toBeGreaterThan(count.x + count.width);
});

test('changed-file hover shows renamed paths in one tooltip', async ({
  page,
}) => {
  await showChangedFiles(page);
  const file = page.locator('[data-file="api-file"]');

  await file.getByText('index.ts', { exact: true }).hover();
  const tooltip = page.getByRole('tooltip');

  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText(
    'packages/api/src/old.ts → packages/api/src/index.ts • Renamed',
  );
  expect(await file.evaluate((row) => row.closest('[title]'))).toBeNull();
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
});

test('ancestor guides paint through an opaque nested file selection background', async ({
  page,
}) => {
  await showChangedFiles(page);
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      '--vscode-tree-indentGuidesStroke',
      '#d7dfeb',
    );
    document.documentElement.style.setProperty(
      '--vscode-tree-inactiveIndentGuidesStroke',
      '#d7dfeb',
    );
  });
  const file = page.locator('[data-file="lock-file"]');
  const group = page.locator('[data-folder="common"] > [role="group"]');

  await file.click();
  await expect(file).toHaveAttribute('aria-selected', 'true');
  const guideX = await group.evaluate((node) =>
    Math.floor(
      node.getBoundingClientRect().x +
        parseFloat(getComputedStyle(node, '::before').left),
    ),
  );
  const row = (await file.boundingBox())!;
  const screenshot = await page.screenshot();
  const pixel = await page.evaluate(
    async ({ image, x, y }) => {
      const bitmap = new Image();

      bitmap.src = 'data:image/png;base64,' + image;
      await bitmap.decode();
      const canvas = document.createElement('canvas');

      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;

      context.drawImage(bitmap, 0, 0);

      return [...context.getImageData(x, y, 1, 1).data];
    },
    {
      image: screenshot.toString('base64'),
      x: guideX,
      y: Math.floor(row.y + row.height / 2),
    },
  );

  expect(pixel).toEqual([215, 223, 235, 255]);
});

test('guides follow selected and keyboard-focused parents while other guides show dimly on hover', async ({
  page,
}) => {
  await showChangedFiles(page);
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      '--vscode-tree-indentGuidesStroke',
      '#d7dfeb',
    );
    document.documentElement.style.setProperty(
      '--vscode-tree-inactiveIndentGuidesStroke',
      '#4e5866',
    );
  });
  const config = page.getByRole('treeitem', { name: 'config/rush 2 files' });
  const group = page.locator('[data-folder="config/rush"] > [role="group"]');
  const other = page.locator('[data-folder="@wk"] > [role="group"]');
  const common = page.locator('[data-folder="common"] > [role="group"]');
  const appearance = (target: typeof group) =>
    target.evaluate((node) => {
      const style = getComputedStyle(node, '::before');

      return { color: style.borderLeftColor, opacity: style.opacity };
    });

  await page.getByRole('button', { name: 'Refresh', exact: true }).hover();
  await expect
    .poll(() => appearance(group))
    .toEqual({
      color: 'rgb(78, 88, 102)',
      opacity: '0',
    });
  await config.focus();
  await expect
    .poll(() => appearance(group))
    .toEqual({
      color: 'rgb(215, 223, 235)',
      opacity: '1',
    });
  await expect
    .poll(() => appearance(common))
    .toEqual({
      color: 'rgb(78, 88, 102)',
      opacity: '0',
    });
  await page.getByRole('button', { name: 'Refresh', exact: true }).focus();
  await config.hover();
  await expect
    .poll(() => appearance(group))
    .toEqual({
      color: 'rgb(78, 88, 102)',
      opacity: '1',
    });
  await page.locator('[data-file="lock-file"]').click();
  await expect
    .poll(() => appearance(group))
    .toEqual({
      color: 'rgb(215, 223, 235)',
      opacity: '1',
    });
  await expect
    .poll(() => appearance(common))
    .toEqual({
      color: 'rgb(78, 88, 102)',
      opacity: '1',
    });
  await page.getByRole('button', { name: 'Refresh', exact: true }).focus();
  await page.getByRole('button', { name: 'Refresh', exact: true }).hover();
  await expect
    .poll(() => appearance(group))
    .toEqual({
      color: 'rgb(215, 223, 235)',
      opacity: '1',
    });
  await expect
    .poll(() => appearance(other))
    .toEqual({
      color: 'rgb(78, 88, 102)',
      opacity: '0',
    });
  await page.getByRole('treeitem', { name: 'Modified · change.json' }).focus();
  await expect
    .poll(() => appearance(other))
    .toEqual({
      color: 'rgb(215, 223, 235)',
      opacity: '1',
    });
  await config.focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(() => appearance(common))
    .toEqual({
      color: 'rgb(215, 223, 235)',
      opacity: '1',
    });
});

test('changed files use counted 22px tree rows, compact paths and full-width selection', async ({
  page,
}) => {
  await showChangedFiles(page);
  const common = page.getByRole('treeitem', {
    name: 'common 4 files',
    exact: true,
  });
  const config = page.getByRole('treeitem', {
    name: 'config/rush 2 files',
    exact: true,
  });
  const file = page.getByRole('treeitem', {
    name: 'Modified · pnpm-lock.yaml',
  });

  await expect(common).toHaveAttribute('aria-expanded', 'true');
  await expect(file).toBeVisible();
  for (const row of [common, config, file])
    expect((await row.boundingBox())!.height).toBe(22);
  await expect(config.locator('.codicon-folder')).toHaveCount(1);
  await expect(
    page
      .getByRole('treeitem', { name: 'Modified · repo-state.json' })
      .locator('.codicon-json'),
  ).toHaveCount(1);
  await file.click();
  await expect(file).toHaveAttribute('aria-selected', 'true');
  const tree = (await page.locator('#files').boundingBox())!;
  const box = (await file.boundingBox())!;

  expect(box.x).toBe(tree.x);
  expect(box.width).toBe(tree.width);
  await config.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(file).not.toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(file).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(file).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(file).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(config).toBeFocused();
  await expect(file).toBeVisible();
});

test('Source Control geometry uses standard icons and compact indentation for file and folder rows', async ({
  page,
}) => {
  await showChangedFiles(page);
  const common = page.getByRole('treeitem', {
    name: 'common 4 files',
    exact: true,
  });
  const config = page.getByRole('treeitem', {
    name: 'config/rush 2 files',
    exact: true,
  });
  const file = page.getByRole('treeitem', {
    name: 'Modified · pnpm-lock.yaml',
  });
  const sibling = page.getByRole('treeitem', {
    name: 'Deleted · obsolete.txt',
  });
  const label = (row: typeof common) => row.locator(':scope > span').nth(2);

  for (const row of [common, config, file, sibling]) {
    const chevron = (await row.locator(':scope > span').nth(0).boundingBox())!;
    const icon = (await row.locator(':scope > span').nth(1).boundingBox())!;
    const text = (await label(row).boundingBox())!;

    expect(icon.width).toBe(16);
    expect(icon.height).toBe(22);
    expect(text.x - icon.x - icon.width).toBe(6);
    expect(chevron.width).toBe(22);
    expect(icon.x - chevron.x).toBe(19);
  }

  const commonLabel = (await label(common).boundingBox())!;
  const configLabel = (await label(config).boundingBox())!;

  expect((await label(sibling).boundingBox())!.x).toBe(commonLabel.x);
  expect(configLabel.x - commonLabel.x).toBe(8);
  expect((await label(file).boundingBox())!.x - configLabel.x).toBe(8);
  await expect(config.locator(':scope > span').nth(2)).toHaveText(
    'config/rush',
  );
  const modifiedName = file.locator(':scope > span').nth(2);
  const addedName = page.locator('[data-file="ems-change"] > span').nth(2);

  await expect(modifiedName).toHaveCSS('color', 'rgb(204, 204, 204)');
  await expect(addedName).toHaveCSS('color', 'rgb(204, 204, 204)');
  await file.click();
  await expect(file).toHaveAttribute('aria-selected', 'true');
});

test('themes without folder icons remove empty slots and align file icons with disclosure arrows', async ({
  page,
}) => {
  await showChangedFiles(page);
  const common = page.getByRole('treeitem', {
    name: 'common 4 files',
    exact: true,
  });
  const sibling = page.getByRole('treeitem', {
    name: 'Deleted · obsolete.txt',
  });
  const image =
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="blue" d="M0 0h16v16H0z"/></svg>';

  await page.evaluate(
    (uri) =>
      window.__deliver({
        requestId: 'icons',
        repositoryId: '',
        generation: 0,
        body: {
          kind: 'file-icon-theme',
          stylesheet: null,
          theme: {
            definitions: { file: { uri } },
            associations: {
              file: 'file',
              fileNames: {},
              fileExtensions: {},
              languageIds: {},
              folderNames: {},
              folderNamesExpanded: {},
            },
            languages: { fileNames: {}, extensions: {} },
          },
        },
      }),
    image,
  );
  const folderText = common.locator(':scope > span').nth(2);
  const folderArrow = common.locator(':scope > span').nth(0);
  const fileIcon = sibling.locator('[data-file-icon]');

  await expect(common.locator('[data-file-icon]')).toHaveCount(0);
  await expect(sibling.locator(':scope > span').nth(0)).not.toBeVisible();
  const arrow = (await folderArrow.boundingBox())!;

  expect((await folderText.boundingBox())!.x).toBe(arrow.x + 19);
  expect((await fileIcon.boundingBox())!.x).toBe(arrow.x - 3);
  await expect(page.locator('[data-parent] > summary')).toContainText(
    'Changes',
  );
  await expect(
    page.locator('[data-parent] > summary .codicon-folder'),
  ).toHaveCount(0);
  const config = page.getByRole('treeitem', {
    name: 'config/rush 2 files',
    exact: true,
  });
  const separator = config.locator('[data-path-separator]');

  await expect(separator).toHaveCSS('opacity', '0.5');
  await expect(separator).toHaveCSS('margin-left', '2px');
  await expect(separator).toHaveCSS('margin-right', '2px');
  await common.click();
  await expect(common).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'icons',
      repositoryId: '',
      generation: 0,
      body: {
        kind: 'file-icon-theme',
        stylesheet: null,
        theme: {
          definitions: {},
          associations: {
            fileNames: {},
            fileExtensions: {},
            languageIds: {},
            folderNames: {},
            folderNamesExpanded: {},
          },
          languages: { fileNames: {}, extensions: {} },
        },
      },
    }),
  );
  await expect(sibling.locator('[data-file-icon]')).toHaveCount(0);
  await expect(sibling.locator(':scope > span').nth(0)).toBeVisible();
  await expect(common).toHaveAttribute('aria-expanded', 'false');
});

test('commit summary shows a short revision, linked email and only the committed date', async ({
  page,
}) => {
  await showChangedFiles(page);
  const info = page.locator('[data-commit-info]');

  await expect(info.getByText('00000000', { exact: true })).toHaveAttribute(
    'title',
    '1'.padStart(40, '0'),
  );
  await expect(info.locator('time')).toHaveCount(1);
  await expect(
    info.getByRole('link', { name: '<fixture@example.test>' }),
  ).toHaveAttribute('href', 'mailto:fixture%40example.test');
  await expect(
    info.locator('time[datetime="2026-08-20T12:19:00Z"]'),
  ).toBeVisible();
  await expect(info.locator('pre')).toHaveCSS('font-weight', '600');
});

test('each octopus parent gets its own group and file activation uses previews', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-commit-row]').first().click();
  await page.evaluate(() => {
    const r = window.__requests.at(-1)!;
    const sha = '1'.padStart(40, '0');
    const parents = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];

    window.__deliver({
      ...r,
      body: {
        kind: 'details',
        commit: {
          sha,
          parents,
          message: 'Octopus',
          authorName: null,
          authorEmail: null,
          authorDate: null,
          commitDate: null,
        },
      },
    });
    window.__deliver({
      ...r,
      body: {
        kind: 'files',
        sha,
        parentSha: parents[0]!,
        files: [
          {
            id: 'f1',
            status: 'renamed',
            oldPath: 'old.txt',
            newPath: 'new.txt',
          },
        ],
      },
    });
  });
  await expect(
    page.getByRole('treeitem', { name: /Changes to Parent/ }),
  ).toHaveCount(3);
  await page.getByRole('treeitem', { name: /Renamed.*new.txt/ }).click();
  await expect
    .poll(
      async () => (await page.evaluate(() => window.__requests)).at(-1)?.body,
    )
    .toEqual({
      kind: 'open-file',
      fileId: 'f1',
      preview: true,
    });
  await page.getByRole('treeitem', { name: /Renamed.*new.txt/ }).press('Enter');
  expect((await page.evaluate(() => window.__requests)).at(-1)?.body).toEqual({
    kind: 'open-file',
    fileId: 'f1',
    preview: false,
  });
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.__requests))
        .filter(
          ({ body }) =>
            body.kind === 'load-parent' && body.parentSha !== 'a'.repeat(40),
        )
        .map(({ body }) =>
          body.kind === 'load-parent' ? body.parentSha : null,
        ),
    )
    .toEqual(['b'.repeat(40), 'c'.repeat(40)]);
  const before = (await page.evaluate(() => window.__requests)).length;

  await page.getByRole('treeitem', { name: /Changes to Parent 2/ }).click();
  expect((await page.evaluate(() => window.__requests)).length).toBe(before);
});

test('fast empty comparisons retain row geometry without flashing loading text', async ({
  page,
}) => {
  await page.goto('/');
  await page.clock.install({ time: new Date('2026-10-08T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-08T00:00:01Z'));
  await page.locator('[data-commit-row]').first().click();
  await page.evaluate(() => {
    const r = window.__requests.at(-1)!;

    window.__deliver({
      ...r,
      body: {
        kind: 'details',
        commit: {
          sha: '1'.padStart(40, '0'),
          parents: ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)],
          message: 'Merge',
          authorName: null,
          authorEmail: null,
          authorDate: null,
          commitDate: null,
        },
      },
    });
    window.__deliver({
      ...r,
      body: {
        kind: 'files',
        sha: '1'.padStart(40, '0'),
        parentSha: 'a'.repeat(40),
        files: [],
      },
    });
  });
  const first = page.locator('[data-parent="' + 'b'.repeat(40) + '"]');
  const second = page.locator('[data-parent="' + 'c'.repeat(40) + '"]');

  await first.locator('summary').click();

  await expect(first.locator('[role="group"]')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(
    first.getByRole('button', { name: 'Retry comparison' }),
  ).toHaveCount(0);
  await expect(
    first.getByText('Loading comparison…', { exact: true }),
  ).toHaveCount(0);
  const y = (await second.boundingBox())!.y;
  const height = (await first.locator('[role="group"]').boundingBox())!.height;

  expect(height).toBe(22);
  await page.clock.runFor(100);
  await page.evaluate(() => {
    const r = window.__requests.at(-1)!;

    for (const parentSha of ['b'.repeat(40), 'c'.repeat(40)])
      window.__deliver({
        ...r,
        body: {
          kind: 'files',
          sha: '1'.padStart(40, '0'),
          parentSha,
          files: [],
        },
      });
  });
  await expect(first.locator('[role="group"]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(second.locator('summary')).toContainText('0 files');
  expect((await second.boundingBox())!.y).toBe(y);
  expect((await first.locator('[role="group"]').boundingBox())!.height).toBe(
    height,
  );
  await page.clock.runFor(500);
  await expect(
    page.getByText('Loading comparison…', { exact: true }),
  ).toHaveCount(0);
});

test('failed parent comparisons settle quietly and toolbar refresh retries them', async ({
  page,
}) => {
  await showChangedFiles(page);
  await page.evaluate(() => {
    const r = window.__requests.at(-1)!;
    const sha = '1'.padStart(40, '0');

    window.__deliver({
      ...r,
      body: {
        kind: 'details',
        commit: {
          sha,
          parents: ['a'.repeat(40), 'b'.repeat(40)],
          message: 'Merge',
          authorName: null,
          authorEmail: null,
          authorDate: null,
          commitDate: null,
        },
      },
    });
    window.__deliver({
      ...r,
      body: {
        kind: 'files-error',
        sha,
        parentSha: 'b'.repeat(40),
        message: 'Parent object unavailable.',
      },
    });
  });
  const second = page.locator('[data-parent="' + 'b'.repeat(40) + '"]');

  await expect(second.locator('summary')).not.toContainText('Unavailable');
  await second.locator('summary').click();
  await expect(second.getByText('Parent object unavailable.')).toHaveCount(0);
  await expect(second.locator('[role="group"]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    second.getByText('No changes compared with this parent.'),
  ).toHaveCount(0);
  await expect(page.locator('[data-file="lock-file"]')).toBeVisible();
  await expect(
    second.getByRole('button', { name: 'Retry comparison' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect(
    (await page.evaluate(() => window.__requests)).some(
      ({ body }) => body.kind === 'refresh',
    ),
  ).toBe(true);
  await page.evaluate(() => {
    const r = window.__requests.at(-1)!;

    window.__deliver({
      ...r,
      body: {
        kind: 'files',
        sha: '1'.padStart(40, '0'),
        parentSha: 'b'.repeat(40),
        files: [],
      },
    });
  });
  await expect(second.locator('summary')).toContainText('0 files');
  await expect(
    second.getByText('No changes compared with this parent.'),
  ).toBeVisible();
  await expect(page.locator('[data-file="lock-file"]')).toBeVisible();
});

test('file activations across merge parents select immediately and preserve preview intent', async ({
  page,
}) => {
  await showChangedFiles(page);
  await page.clock.install();
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
          message: 'Merge',
          authorName: null,
          authorEmail: null,
          authorDate: null,
          commitDate: null,
        },
      },
    });
    for (const [index, fileId, path] of [
      [0, 'preview-a', 'one/a.ts'],
      [1, 'immediate-b', 'two/b.ts'],
    ] as const)
      window.__deliver({
        ...request,
        body: {
          kind: 'files',
          sha,
          parentSha: parents[index]!,
          files: [
            { id: fileId, status: 'modified', oldPath: path, newPath: path },
          ],
        },
      });
  });
  await page.getByRole('treeitem', { name: /Changes to Parent 2/ }).click();
  await page.locator('[data-file="preview-a"]').click();
  expect(await page.evaluate(() => window.__requests.at(-1)?.body)).toEqual({
    kind: 'open-file',
    fileId: 'preview-a',
    preview: true,
  });
  await expect(page.locator('[data-file="preview-a"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.locator('[data-file="immediate-b"]').press('Enter');
  await page.clock.runFor(1000);
  expect(
    await page.evaluate(() =>
      window.__requests
        .filter((request) => request.body.kind === 'open-file')
        .map((request) => request.body),
    ),
  ).toEqual([
    { kind: 'open-file', fileId: 'preview-a', preview: true },
    { kind: 'open-file', fileId: 'immediate-b', preview: false },
  ]);
  await expect(page.locator('[data-file="immediate-b"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('font theme percentages follow label sizing without changing icon slots', async ({
  page,
}) => {
  await showChangedFiles(page);
  await page.addStyleTag({
    content:
      '.git-file-theme-browser::before{content:"\\e001";font-family:monospace;font-size:150%}',
  });
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'icons',
      repositoryId: '',
      generation: 0,
      body: {
        kind: 'file-icon-theme',
        stylesheet: null,
        theme: {
          definitions: { file: { className: 'git-file-theme-browser' } },
          associations: {
            file: 'file',
            fileNames: {},
            fileExtensions: {},
            languageIds: {},
            folderNames: {},
            folderNamesExpanded: {},
          },
          languages: { fileNames: {}, extensions: {} },
        },
      },
    }),
  );
  const icon = page.locator('[data-file="ems-change"] [data-file-icon]');

  for (const [label, glyph] of [
    [13, 19.5],
    [15, 22.5],
  ]) {
    await page.evaluate(
      (size) =>
        document.documentElement.style.setProperty(
          '--vscode-font-size',
          size + 'px',
        ),
      label!,
    );
    await expect
      .poll(() =>
        icon.evaluate((node) =>
          parseFloat(getComputedStyle(node, '::before').fontSize),
        ),
      )
      .toBe(glyph);
    await expect(icon).toHaveCSS('width', '16px');
    await expect(icon).toHaveCSS('height', '22px');
  }
});
