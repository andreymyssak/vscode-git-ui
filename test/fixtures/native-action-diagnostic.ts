import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame } from '@playwright/test';

type FailureContext = {
  frame: Frame;
  name: string;
};

async function capture({ frame, name }: FailureContext) {
  const artifacts = process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts';
  const page = frame.page();
  const workbench = await page.evaluate(() => ({
    focused: document.hasFocus(),
    active: document.activeElement?.outerHTML.slice(0, 1000),
    pickers: Array.from(
      document.querySelectorAll('.quick-input-widget'),
      (widget) => ({
        visible: widget.getBoundingClientRect().height > 0,
        text: widget.textContent?.slice(0, 3000),
        inputs: Array.from(widget.querySelectorAll('input'), (input) => ({
          visible: input.getBoundingClientRect().height > 0,
          focused: document.activeElement === input,
          placeholder: input.placeholder,
          value: input.value,
        })),
      }),
    ),
    notifications: Array.from(
      document.querySelectorAll('.notification-list-item'),
      (item) => item.textContent,
    ),
    menus: Array.from(
      document.querySelectorAll('[role="menuitem"]'),
      (item) => ({
        text: item.textContent,
        disabled: item.getAttribute('aria-disabled'),
      }),
    ),
  }));
  const changes = await frame.evaluate(() => ({
    focused: document.hasFocus(),
    active: document.activeElement?.outerHTML.slice(0, 1000),
    context: document
      .querySelector('[data-source-control]')
      ?.getAttribute('data-vscode-context'),
    text: document.body.innerText.slice(0, 5000),
    rows: Array.from(document.querySelectorAll('[data-file]'), (row) => ({
      path: row.getAttribute('data-file'),
      disabled: row.getAttribute('aria-disabled'),
      context: row.getAttribute('data-vscode-context'),
    })),
  }));

  await writeFile(
    join(artifacts, `${name}-failure.json`),
    JSON.stringify({ workbench, changes }),
  );
  await page.screenshot({
    path: join(artifacts, `${name}-failure.png`),
    timeout: 5000,
  });
}

export async function captureNativeActionFailure(options: FailureContext) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      capture(options),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Diagnostic capture timed out.')),
          6000,
        );
      }),
    ]);
  } catch (error) {
    console.warn(
      `Could not capture ${options.name} failure diagnostics:`,
      error,
    );
  } finally {
    clearTimeout(timeout);
  }
}
