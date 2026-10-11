import assert from 'node:assert/strict';

import { expect, type Locator, type Page } from '@playwright/test';

import { nativeBrowser } from './native-panel';

export async function workbench(): Promise<Page> {
  const browser = await nativeBrowser();
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('/workbench/workbench.html'));

  assert.ok(page);

  return page;
}

export async function annotationTexts(page: Page): Promise<string[]> {
  return page
    .locator('.monaco-editor .view-line span')
    .evaluateAll((spans) =>
      spans
        .map((span) =>
          getComputedStyle(span, '::before')
            .content.replace(/^"|"$/g, '')
            .trim(),
        )
        .filter((content) =>
          /^(?:\d{2}\.\d{2}\.\d{4} .+|Not committed yet)$/u.test(content),
        ),
    );
}

export async function nativeHover(
  editor: Locator,
  text: string,
  occurrence = 0,
): Promise<Locator> {
  const hover = editor
    .page()
    .locator('.monaco-hover:visible')
    .filter({
      hasText: text === 'Not committed yet' ? text : 'Open Commit in Git UI',
    })
    .last();

  await expect(async () => {
    const point = await annotationPoint(editor, text, occurrence);

    await editor.page().mouse.click(point.codeX, point.y);
    await editor.page().mouse.move(0, 0);
    await editor.page().mouse.move(point.x, point.y, { steps: 5 });
    await expect(hover).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 10000 });

  return hover;
}

export async function annotationPoint(
  editor: Locator,
  text: string,
  occurrence = 0,
) {
  await expect
    .poll(() =>
      editor
        .locator('.view-line span')
        .evaluateAll(
          (spans, { text, occurrence }) =>
            spans.filter((span) =>
              getComputedStyle(span, '::before').content.includes(text),
            )[occurrence] !== undefined,
          { text, occurrence },
        ),
    )
    .toBe(true);
  const point = await editor.locator('.view-line span').evaluateAll(
    (spans, { wanted, occurrence }) => {
      const span = spans.filter((value) =>
        getComputedStyle(value, '::before').content.includes(wanted),
      )[occurrence];

      if (!span) return null;
      const rect = span.getBoundingClientRect();
      const before = getComputedStyle(span, '::before');

      return {
        x: rect.left + 8,
        y: rect.top + rect.height / 2,
        codeX:
          rect.left +
          parseFloat(before.width) +
          parseFloat(before.paddingRight) +
          parseFloat(before.borderRightWidth) +
          parseFloat(before.marginRight) +
          16,
      };
    },
    { wanted: text, occurrence },
  );

  assert.ok(point, `No rendered annotation containing ${text}`);

  return point;
}
