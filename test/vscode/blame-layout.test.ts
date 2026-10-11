import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, type Locator } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { commandId } from '../../src/shared/extension-identity';
import {
  annotationPoint,
  nativeHover,
  workbench,
} from '../fixtures/native-blame';
import { nativePanel } from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

async function setup(author = 'Fixture') {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  const fixture = await createFixture({ prefix: 'git-ui-blame-layout-' });
  const path = join(fixture.root, 'layout.ts');
  const message =
    'Explain the layout\n\n' +
    'Keep source text readable when annotations are shown and when the editor is scrolled. '.repeat(
      16,
    ) +
    '\n\n    ' +
    'An indented explanation should still wrap at word boundaries. '.repeat(
      20,
    ) +
    '\n\n1. A numbered sentence stays plain text.\n\n<command:gitUI.unexpected>\n\n<https://example.test/>\n\n' +
    '\n\nLiteral [unsafe](command:gitUI.unexpected) <script>alert(1)</script> `code`.';
  const text =
    [
      'export class Layout {',
      '  render() {',
      ...Array.from(
        { length: 800 },
        (_, index) => `    const value${index} = ${index};`,
      ),
      '  }',
      '}',
    ].join('\n') + '\n';

  await writeFile(path, text);
  await fixture.runGit(['add', 'layout.ts']);
  await fixture.runGit([
    'commit',
    '--author',
    `${author} <fixture@example.test>`,
    '-m',
    message,
  ]);
  const sha = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
  const access = await getGitApi();
  const repository = await access.api.openRepository(
    vscode.Uri.file(fixture.root),
  );

  assert.ok(repository);
  await repository.status();
  const editor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(path),
    { preview: false },
  );

  assert.equal(
    await vscode.commands.executeCommand(commandId('annotate-blame')),
    true,
  );
  const page = await workbench();
  const native = page
    .locator('.monaco-editor')
    .filter({
      has: page.locator('.view-lines', { hasText: 'const value' }),
    })
    .last();

  await annotationPoint(native, author);

  return {
    editor,
    native,
    page,
    message,
    sha,
    repositoryId: repository.rootUri.toString(),
    async dispose() {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand(commandId('close-blame'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fixture.dispose();
    },
  };
}

async function highlights(native: Locator): Promise<number> {
  return native.locator('.view-overlays [class*="ced-"]').count();
}

async function annotationColors(native: Locator): Promise<string[]> {
  return native.locator('.view-line span').evaluateAll((spans) => [
    ...new Set(
      spans
        .filter((span) =>
          getComputedStyle(span, '::before').content.includes('Fixture'),
        )
        .map((span) => {
          const style = getComputedStyle(span, '::before');

          return `${style.color}:${style.backgroundColor}`;
        }),
    ),
  ]);
}

describe('native Blame layout', () => {
  it('preserves the source text baseline when annotations are shown', async function () {
    this.timeout(60000);
    const f = await setup();
    const sourceOffset = () =>
      f.native
        .locator('.view-line')
        .first()
        .evaluate((row) => {
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          let text = walker.nextNode();

          while (text && !text.textContent?.includes('export'))
            text = walker.nextNode();

          if (!text) return null;
          const range = document.createRange();

          range.selectNodeContents(text);

          return (
            range.getBoundingClientRect().top - row.getBoundingClientRect().top
          );
        });

    try {
      const annotated = await sourceOffset();

      assert.notEqual(annotated, null);
      await vscode.commands.executeCommand(commandId('close-blame'));
      await expect
        .poll(() =>
          f.native
            .locator('.view-line span')
            .evaluateAll((spans) =>
              spans.some((span) =>
                getComputedStyle(span, '::before').content.includes('Fixture'),
              ),
            ),
        )
        .toBe(false);
      await expect.poll(sourceOffset).toBe(annotated);
    } finally {
      await f.dispose();
    }
  });
  it('keeps wide author names inside the annotation column', async function () {
    this.timeout(60000);
    const author = '王'.repeat(14);
    const f = await setup(author);

    try {
      await expect
        .poll(() =>
          f.native.locator('.view-line span').evaluateAll((spans, author) => {
            const label = spans.find((span) =>
              getComputedStyle(span, '::before').content.includes(author),
            );

            if (!label) return false;
            const style = getComputedStyle(label, '::before');
            const context = document.createElement('canvas').getContext('2d');

            if (!context) return false;
            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const text = style.content.replace(/^"|"$/g, '');

            return (
              context.measureText(text).width <= parseFloat(style.width) + 1 ||
              (style.overflowX !== 'visible' &&
                style.textOverflow === 'ellipsis')
            );
          }, author),
        )
        .toBe(true);
      await f.page.screenshot({ path: '.artifacts/blame-wide-author.png' });
      const hover = await nativeHover(f.native, author);

      await expect(hover).toContainText(author);
    } finally {
      await f.dispose();
    }
  });
  it('keeps partially visible rows aligned while scrolling', async function () {
    this.timeout(60000);
    const f = await setup();

    try {
      f.editor.revealRange(
        new vscode.Range(200, 0, 200, 0),
        vscode.TextEditorRevealType.InCenter,
      );
      await expect(
        f.native.locator('.view-line').filter({ hasText: 'const value198' }),
      ).toBeVisible();
      const box = await f.native.boundingBox();

      assert.ok(box);
      await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await f.page.mouse.wheel(0, 7);
      await expect
        .poll(() =>
          f.native.evaluate((editor) => {
            const viewport = editor.getBoundingClientRect();

            return [...editor.querySelectorAll('.view-lines .view-line')]
              .filter((row) => {
                const rect = row.getBoundingClientRect();

                return (
                  rect.bottom > viewport.top &&
                  rect.top < viewport.bottom &&
                  row.textContent?.includes('const value')
                );
              })
              .filter(
                (row) =>
                  ![...row.querySelectorAll('span')].some((span) =>
                    /\d{2}\.\d{2}\.\d{4}/.test(
                      getComputedStyle(span, '::before').content,
                    ),
                  ),
              )
              .map((row) => row.textContent);
          }),
        )
        .toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  it('annotates pinned headings after they have scrolled far out of view', async function () {
    this.timeout(60000);
    const config = vscode.workspace.getConfiguration('editor.stickyScroll');
    const previous = config.inspect<boolean>('enabled')?.globalValue;

    await config.update('enabled', true, vscode.ConfigurationTarget.Global);
    const f = await setup();

    try {
      await expect
        .poll(
          async () =>
            (
              await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                f.editor.document.uri,
              )
            )?.length ?? 0,
        )
        .toBeGreaterThan(0);
      f.editor.revealRange(
        new vscode.Range(600, 0, 600, 0),
        vscode.TextEditorRevealType.InCenter,
      );
      const headings = f.native.locator('.sticky-widget .sticky-line-content');

      await expect(headings.first()).toBeVisible();
      await expect
        .poll(() =>
          headings.evaluateAll((rows) =>
            rows.every((row) =>
              [...row.querySelectorAll('span')].some((span) =>
                /\d{2}\.\d{2}\.\d{4}/.test(
                  getComputedStyle(span, '::before').content,
                ),
              ),
            ),
          ),
        )
        .toBe(true);
    } finally {
      await f.dispose();
      await config.update(
        'enabled',
        previous,
        vscode.ConfigurationTarget.Global,
      );
    }
  });
  it('shows a pointer over clickable annotation labels', async function () {
    this.timeout(60000);
    const f = await setup();

    try {
      await expect
        .poll(() =>
          f.native.locator('.view-line span').evaluateAll((spans) => {
            const label = spans.find((span) =>
              getComputedStyle(span, '::before').content.includes('Fixture'),
            );

            return label ? getComputedStyle(label, '::before').cursor : null;
          }),
        )
        .toBe('pointer');
    } finally {
      await f.dispose();
    }
  });
  it('wraps long commit messages safely within the native hover', async function () {
    this.timeout(60000);
    const f = await setup();

    try {
      const hover = await nativeHover(f.native, 'Fixture');

      await expect(hover).toContainText(
        'Literal [unsafe](command:gitUI.unexpected)',
      );
      assert.equal(
        await hover.locator('a[data-href*="gitUI.unexpected"]').count(),
        0,
      );
      await expect
        .poll(() =>
          hover.evaluate((element) =>
            [
              ...element.querySelectorAll(
                '.monaco-scrollable-element, .markdown-hover',
              ),
            ].every((row) => row.scrollWidth <= row.clientWidth + 1),
          ),
        )
        .toBe(true);
      await expect(hover).toContainText('Keep source text readable');
      await expect(hover.locator('pre')).toHaveCount(0);
      await expect(hover.locator('ol, ul')).toHaveCount(0);
      await expect(hover.locator('a[data-href^="command:"]')).toHaveCount(1);
      await expect(hover.locator('a')).toHaveCount(1);
      const link = hover.getByRole('link', { name: 'Open Commit in Git UI' });

      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport();
      await f.page.screenshot({ path: '.artifacts/blame-layout-hover.png' });
    } finally {
      await f.dispose();
    }
  });
  it('keeps blame colors unchanged when clicking an annotation to open the commit', async function () {
    this.timeout(60000);
    const f = await setup();

    try {
      f.editor.selection = new vscode.Selection(3, 8, 3, 8);
      const point = await annotationPoint(f.native, 'Fixture', 2);

      await f.page.mouse.click(point.codeX + 40, point.y);
      await expect.poll(() => highlights(f.native)).toBe(0);
      await vscode.commands.executeCommand('cursorDown');
      await expect.poll(() => highlights(f.native)).toBe(0);

      const label = await annotationPoint(f.native, 'Fixture', 2);
      const ageColors = await annotationColors(f.native);

      await f.page.mouse.click(label.x, label.y);
      const frame = await nativePanel(f.repositoryId);

      await expect(
        frame.locator(`[data-commit-row][data-sha="${f.sha}"]`),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(
        frame.locator('#details[aria-busy="false"] [data-path="layout.ts"]'),
      ).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => highlights(f.native)).toBe(0);
      await expect.poll(() => annotationColors(f.native)).toEqual(ageColors);
      const end = f.editor.document.lineCount - 1;

      assert.equal(f.editor.document.lineAt(end).text, '');
      f.editor.selection = new vscode.Selection(end, 0, end, 0);
      await expect.poll(() => highlights(f.native)).toBe(0);
      await expect.poll(() => annotationColors(f.native)).toEqual(ageColors);
    } finally {
      await f.dispose();
    }
  });
});
