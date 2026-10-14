import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Frame } from '@playwright/test';
import * as vscode from 'vscode';

import { createSourceControlBackend } from '../../src/extension/git/source-control/index';
import { openedChangePath } from '../../src/extension/native/opened-change';

export async function observeReveal({
  frame,
  root,
}: {
  frame: Frame;
  root: string;
}) {
  const observer = await frame.evaluateHandle(() => {
    const responses: unknown[] = [];
    const listen = (event: MessageEvent) => {
      const value: unknown = event.data;

      if (
        value &&
        typeof value === 'object' &&
        'kind' in value &&
        value.kind === 'source-control-state' &&
        'state' in value
      ) {
        responses.push(value.state);
        if (responses.length > 20) responses.shift();
      }
    };

    window.addEventListener('message', listen);

    return {
      responses,
      stop: () => window.removeEventListener('message', listen),
    };
  });

  return {
    async capture() {
      const backend = await createSourceControlBackend();

      try {
        const uri = vscode.Uri.file(root);
        const files = await backend.workingChanges(uri.toString());
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        const active =
          input instanceof vscode.TabInputText
            ? [input.uri]
            : input instanceof vscode.TabInputTextDiff
              ? [input.modified, input.original]
              : [];
        const artifacts = process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts';

        await frame.page().screenshot({
          path: join(artifacts, 'source-control-reveal-failure.png'),
        });
        await writeFile(
          join(artifacts, 'source-control-reveal-failure.json'),
          JSON.stringify({
            root: uri.toString(),
            active: active.map((uri) => ({
              uri: uri.toString(),
              fsPath: uri.fsPath,
            })),
            opened: openedChangePath(uri, files),
            responses: await observer.evaluate((state) => state.responses),
            render: await frame.evaluate(() => ({
              focused: document.hasFocus(),
              active: document.activeElement?.getAttribute('aria-label'),
              rows: Array.from(
                document.querySelectorAll('[data-file]'),
                (row) => ({
                  path: row.getAttribute('data-file'),
                  selected: row.getAttribute('aria-selected'),
                  disabled: row.getAttribute('aria-disabled'),
                }),
              ),
            })),
          }),
        );
      } finally {
        backend.dispose();
      }
    },
    async dispose() {
      try {
        await observer.evaluate((state) => state.stop());
      } finally {
        await observer.dispose();
      }
    },
  };
}
