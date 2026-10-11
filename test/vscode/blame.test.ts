import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';
import * as vscode from 'vscode';

import { getGitApi, type GitAPI } from '../../src/extension/git/api';
import { commandId, LOG_VIEW_ID } from '../../src/shared/extension-identity';
import {
  nativeBrowser,
  nativePanel,
  selectNativeRepository,
} from '../fixtures/native-panel';
import { createFixture } from '../fixtures/repository';

async function workbench(): Promise<Page> {
  const browser = await nativeBrowser();
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('/workbench/workbench.html'));

  assert.ok(page);

  return page;
}

async function annotationTexts(page: Page): Promise<string[]> {
  return page
    .locator('.monaco-editor .view-line span')
    .evaluateAll((spans) =>
      spans
        .map((span) => getComputedStyle(span, '::before').content)
        .filter(
          (content) =>
            content.includes('Fixture') ||
            content.includes('Not committed yet'),
        ),
    );
}

async function annotateMenu(editor: Locator, line = '1'): Promise<void> {
  await editor
    .locator('.line-numbers')
    .filter({ hasText: new RegExp(`^${line}$`) })
    .first()
    .click({ button: 'right' });
  const item = editor
    .page()
    .getByRole('menuitem', { name: 'Annotate with Git Blame', exact: true });

  await expect(item).not.toHaveAttribute('aria-disabled', 'true');
  await editor.page().getByRole('menu').last().focus();
  await editor.page().keyboard.press('End');
  await editor.page().keyboard.press('Enter');
  await expect(item).toBeHidden();
}

async function nativeHover(
  editor: Locator,
  text: string,
  occurrence = 0,
): Promise<Locator> {
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

      return {
        x: rect.left + 8,
        y: rect.top + rect.height / 2,
        codeX:
          rect.left + parseFloat(getComputedStyle(span, '::before').width) + 8,
      };
    },
    { wanted: text, occurrence },
  );

  assert.ok(point, `No rendered annotation containing ${text}`);
  await editor.page().mouse.click(point.codeX, point.y);
  await editor.page().mouse.move(0, 0);
  await editor.page().mouse.move(point.x, point.y, { steps: 5 });
  const hover = editor
    .page()
    .locator('.monaco-hover:visible')
    .filter({
      hasText: text === 'Not committed yet' ? text : 'Open Commit in Git UI',
    })
    .last();

  await expect(hover).toBeVisible();

  return hover;
}

async function selectedCommit(id: string, sha: string): Promise<void> {
  const frame = await nativePanel(id);
  const row = frame.locator(`[data-commit-row][data-sha="${sha}"]`);

  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(row).toBeInViewport();
  await expect(
    frame.locator('#details[aria-busy="false"] [data-path="sample.txt"]'),
  ).toBeVisible();
  await expect(
    frame.locator(`[data-commit-info] [title="${sha}"]`),
  ).toBeVisible();
}

describe('native Git UI blame', () => {
  for (const failOlder of [false, true])
    it(`keeps the newest commit click when older validation ${failOlder ? 'fails' : 'finishes'} late`, async function () {
      this.timeout(60000);
      const fixture = await createFixture({
        prefix: 'git-ui-blame-click-order-',
      });
      const path = join(fixture.root, 'sample.txt');
      const id = vscode.Uri.file(fixture.root).toString();
      const older = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      await writeFile(path, 'first\nsecond\n');
      await fixture.runGit(['add', '--', 'sample.txt']);
      await fixture.runGit(['commit', '-m', 'Newest clicked commit']);
      const newer = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
      const gitExtension = vscode.extensions.getExtension<{
        getAPI(version: 1): GitAPI;
      }>('vscode.git');

      assert.ok(gitExtension);
      const getAPI = gitExtension.exports.getAPI;
      const getCommit = repository.getCommit;
      let release = () => {};

      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = false;
      let pending: Thenable<unknown> | undefined;

      repository.getCommit = async (ref) => {
        if (ref === older && !started) {
          started = true;
          await held;
          if (failOlder) throw new Error('Superseded blame validation failure');
        }

        return getCommit.call(repository, ref);
      };

      // VS Code creates new repository wrappers for each public API request.
      gitExtension.exports.getAPI = (version) => {
        const api = getAPI.call(gitExtension.exports, version);

        return new Proxy(api, {
          get: (target, property) => {
            if (property === 'repositories')
              return target.repositories.map((candidate) =>
                candidate.rootUri.toString() === id ? repository : candidate,
              );
            const value: unknown = Reflect.get(target, property, target);

            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };

      try {
        await vscode.commands.executeCommand('notifications.clearAll');
        pending = vscode.commands.executeCommand(
          commandId('open-blame-commit'),
          {
            documentUri: vscode.Uri.file(path).toString(),
            sha: older,
          },
        );
        await expect.poll(() => started).toBe(true);
        assert.equal(
          await vscode.commands.executeCommand(commandId('open-blame-commit'), {
            documentUri: vscode.Uri.file(path).toString(),
            sha: newer,
          }),
          true,
        );
        await selectedCommit(id, newer);
        release();
        await pending;
        await selectedCommit(id, newer);
        if (failOlder) {
          const page = await workbench();

          await vscode.commands.executeCommand('notifications.showList');
          await expect(
            page.locator('.notification-list-item').filter({
              hasText: 'Superseded blame validation failure',
            }),
          ).toHaveCount(0);
        }
      } finally {
        release();
        await pending;
        repository.getCommit = getCommit;
        gitExtension.exports.getAPI = getAPI;
        await vscode.commands.executeCommand('notifications.hideList');
        await vscode.commands.executeCommand(
          'workbench.action.closeAllEditors',
        );
        await fixture.dispose();
      }
    });

  it('traces rendered annotations through commit details and both native diff sides', async function () {
    this.timeout(120000);
    assert.ok(
      (await vscode.commands.getCommands()).includes(
        commandId('annotate-blame'),
      ),
    );
    const fixture = await createFixture({ prefix: 'git-ui-blame-flow-' });
    const other = await createFixture({ prefix: 'git-ui-blame-other-' });
    const path = join(fixture.root, 'sample.txt');
    const id = vscode.Uri.file(fixture.root).toString();
    let page: Page | undefined;
    let dirty: vscode.TextDocument | undefined;

    try {
      await writeFile(path, 'first\nsecond\n');
      await fixture.runGit(['add', 'sample.txt']);
      await fixture.runGit(['commit', '-m', 'Add second line']);
      const previous = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

      await writeFile(path, 'first\nmodified second\nthird\n');
      await fixture.runGit(['add', 'sample.txt']);
      await fixture.runGit([
        'commit',
        '-m',
        'Change second line',
        '-m',
        'Full native hover message.',
      ]);
      const head = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();
      const index = await fixture.runGit(['ls-files', '--stage', '-z']);
      const status = await fixture.runGit(['status', '--porcelain=v1']);
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      await access.api.openRepository(vscode.Uri.file(other.root));
      await access.repository(id).status();
      await expect
        .poll(() => access.repository(id).state.HEAD?.commit)
        .toBe(head);
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      await selectNativeRepository(vscode.Uri.file(other.root).toString());
      await vscode.commands.executeCommand('workbench.action.closePanel');
      dirty = await vscode.workspace.openTextDocument(path);
      const editor = await vscode.window.showTextDocument(dirty, {
        preview: false,
      });

      await editor.edit((edit) =>
        edit.insert(new vscode.Position(0, 0), 'unsaved\n'),
      );
      page = await workbench();
      const working = page
        .locator('.monaco-editor')
        .filter({ has: page.locator('.view-line', { hasText: 'modified' }) })
        .last();

      await annotateMenu(working);
      await expect
        .poll(() => annotationTexts(page!))
        .toContain('"Not committed yet"');
      const uncommitted = await nativeHover(working, 'Not committed yet');

      await expect(
        uncommitted.getByRole('link', { name: 'Open Commit in Git UI' }),
      ).toHaveCount(0);
      await page.mouse.move(0, 0);
      const linkHover = await nativeHover(working, 'Fixture', 1);

      await expect(linkHover).toContainText('Full native hover message.');

      await page.screenshot({ path: '.artifacts/blame-native-hover.png' });
      // This source belongs to a different repository from the active Log.
      await linkHover
        .getByRole('link', { name: 'Open Commit in Git UI' })
        .click();
      await selectedCommit(id, head);
      // A link keeps its source identity after focus moves elsewhere.
      await vscode.commands.executeCommand(commandId('open-blame-commit'), {
        documentUri: dirty.uri.toString(),
        sha: head,
      });
      await selectedCommit(id, head);
      const frame = await nativePanel(id);

      await vscode.commands.executeCommand(
        'workbench.action.closeAuxiliaryBar',
      );
      await vscode.commands.executeCommand('workbench.action.closeSidebar');

      await frame
        .locator('#details[aria-busy="false"] [data-path="sample.txt"]')
        .dblclick();
      const originalUri = access.api.toGitUri(vscode.Uri.file(path), previous);
      const modifiedUri = access.api.toGitUri(vscode.Uri.file(path), head);

      await expect
        .poll(() =>
          vscode.window.visibleTextEditors.map((value) =>
            value.document.uri.toString(),
          ),
        )
        .toContain(originalUri.toString());
      for (const uri of [originalUri, modifiedUri])
        assert.equal(
          await vscode.commands.executeCommand(commandId('annotate-blame'), {
            uri,
            lineNumber: 2,
          }),
          true,
        );
      const original = vscode.window.visibleTextEditors.find(
        (value) => value.document.uri.toString() === originalUri.toString(),
      );
      const modified = vscode.window.visibleTextEditors.find(
        (value) => value.document.uri.toString() === modifiedUri.toString(),
      );

      assert.ok(original && modified);
      const diffOriginal = page.locator(
        '.monaco-diff-editor .editor.original .monaco-editor',
      );
      const diffModified = page.locator(
        '.monaco-diff-editor .editor.modified .monaco-editor',
      );
      const newerHover = await nativeHover(diffModified, 'Fixture', 1);

      await expect(
        newerHover.getByRole('link', { name: 'Open Commit in Git UI' }),
      ).toHaveAttribute('data-href', new RegExp(head));
      const olderHover = await nativeHover(diffOriginal, 'Fixture', 1);

      await expect(
        olderHover.getByRole('link', { name: 'Open Commit in Git UI' }),
      ).toHaveAttribute('data-href', new RegExp(previous));

      await olderHover
        .getByRole('link', { name: 'Open Commit in Git UI' })
        .click();
      await selectedCommit(id, previous);
      await frame
        .getByRole('searchbox', { name: 'Text or hash' })
        .fill('no-matching-commit');
      await frame
        .getByRole('searchbox', { name: 'Text or hash' })
        .press('Enter');
      await expect(frame.locator('[data-commit-row]')).toHaveCount(0);
      await frame.getByRole('tab', { name: 'Worktrees', exact: true }).click();
      await vscode.commands.executeCommand(commandId('open-blame-commit'), {
        documentUri: originalUri.toString(),
        sha: previous,
      });
      await selectedCommit(id, previous);
      await expect(
        frame.getByRole('tab', { name: 'Log', exact: true }),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(
        frame.getByRole('searchbox', { name: 'Text or hash' }),
      ).toHaveValue('');
      await page.screenshot({ path: '.artifacts/blame-native-diff.png' });
      assert.equal((await fixture.runGit(['rev-parse', 'HEAD'])).trim(), head);
      assert.equal(await fixture.runGit(['ls-files', '--stage', '-z']), index);
      assert.equal(await fixture.runGit(['status', '--porcelain=v1']), status);
      assert.equal(
        await readFile(path, 'utf8'),
        'first\nmodified second\nthird\n',
      );
      await vscode.commands.executeCommand(commandId('close-blame'), {
        uri: originalUri,
        lineNumber: 1,
      });
      await expect
        .poll(() =>
          diffOriginal
            .locator('.view-line span')
            .evaluateAll((spans) =>
              spans.some((span) =>
                getComputedStyle(span, '::before').content.includes('Fixture'),
              ),
            ),
        )
        .toBe(false);
    } catch (error) {
      await page?.screenshot({ path: '.artifacts/blame-flow-failure.png' });
      throw error;
    } finally {
      if (dirty && !dirty.isClosed) {
        await vscode.window.showTextDocument(dirty);
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        );
      }

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fixture.dispose();
      await other.dispose();
    }
  });

  it('validates command arguments and uses native notices for files without history', async () => {
    assert.ok(
      (await vscode.commands.getCommands()).includes(
        commandId('annotate-blame'),
      ),
    );
    const fixture = await createFixture({ prefix: 'git-ui-blame-notices-' });
    const access = await getGitApi();

    const repository = await access.api.openRepository(
      vscode.Uri.file(fixture.root),
    );

    assert.ok(repository);
    await repository.status();
    await expect
      .poll(() => repository.state.HEAD?.commit)
      .toBe((await fixture.runGit(['rev-parse', 'HEAD'])).trim());
    const page = await workbench();

    try {
      for (const argument of [
        { uri: 'not-a-uri', lineNumber: 1 },
        {
          uri: vscode.Uri.file(join(fixture.root, 'sample.txt')),
          lineNumber: 0,
        },
      ])
        assert.equal(
          await vscode.commands.executeCommand(
            commandId('annotate-blame'),
            argument,
          ),
          false,
        );
      for (const argument of [
        { documentUri: 'file:///missing', sha: '--all' },
        { documentUri: 'untitled:bad', sha: 'a'.repeat(40) },
        null,
      ])
        assert.equal(
          await vscode.commands.executeCommand(
            commandId('open-blame-commit'),
            argument,
          ),
          false,
        );
      await vscode.commands.executeCommand('notifications.clearAll');
      await writeFile(join(fixture.root, 'new.txt'), 'new file\n');
      const document = await vscode.workspace.openTextDocument(
        join(fixture.root, 'new.txt'),
      );

      await vscode.window.showTextDocument(document);
      assert.equal(
        await vscode.commands.executeCommand(commandId('annotate-blame')),
        true,
      );
      await vscode.commands.executeCommand('notifications.showList');
      await expect(
        page
          .locator('.notification-list-item')
          .filter({ hasText: 'no committed history' })
          .last(),
      ).toBeVisible();
      await expect.poll(() => annotationTexts(page)).toEqual([]);
      await vscode.commands.executeCommand('notifications.hideList');
      assert.equal(
        await vscode.commands.executeCommand(
          commandId('annotate-blame'),
          vscode.Uri.file(join(fixture.root, 'missing.txt')),
        ),
        false,
      );
      await vscode.commands.executeCommand('notifications.showList');
      await expect(
        page
          .locator('.notification-list-item')
          .filter({ hasText: 'open text editor' })
          .last(),
      ).toBeVisible();
      await vscode.commands.executeCommand('notifications.hideList');
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(
          join(fixture.root, 'sample.txt'),
        ),
      );
      await writeFile(join(fixture.root, '.git/shallow'), 'invalid\n');
      try {
        assert.equal(
          await vscode.commands.executeCommand(commandId('annotate-blame')),
          false,
        );
        await vscode.commands.executeCommand('notifications.showList');
        await expect(
          page
            .locator('.notification-list-item')
            .filter({ hasText: 'bad shallow line' })
            .last(),
        ).toBeVisible();
      } finally {
        await unlink(join(fixture.root, '.git/shallow'));
      }
    } catch (error) {
      await writeFile(
        '.artifacts/blame-notices-failure.json',
        JSON.stringify({
          body: await page.locator('body').innerText(),
          annotations: await annotationTexts(page),
        }),
      );
      throw error;
    } finally {
      await vscode.commands.executeCommand('notifications.hideList');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fixture.dispose();
    }
  });
  it('keeps native annotations readable with long authors, wrapping, folding and narrow editors', async function () {
    this.timeout(60000);
    const fixture = await createFixture({ prefix: 'git-ui-blame-layout-' });
    const path = join(fixture.root, 'layout.ts');
    const configuration = vscode.workspace.getConfiguration();
    const theme = configuration.inspect<string>(
      'workbench.colorTheme',
    )?.globalValue;
    const wrap = configuration.inspect<string>('editor.wordWrap')?.globalValue;

    try {
      await writeFile(
        path,
        `function example() {\n  const value = '${'long text '.repeat(25)}';\n  return value;\n}\n`,
      );
      await fixture.runGit(['add', 'layout.ts']);
      await fixture.runGit([
        'commit',
        '--author',
        'Fixture With a Very Long Name <long@example.test>',
        '-m',
        'Long author layout',
      ]);
      const access = await getGitApi();
      const repository = await access.api.openRepository(
        vscode.Uri.file(fixture.root),
      );

      assert.ok(repository);
      await repository.status();
      const document = await vscode.workspace.openTextDocument(path);

      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
      await vscode.commands.executeCommand('workbench.action.closePanel');
      assert.equal(
        await vscode.commands.executeCommand(commandId('annotate-blame')),
        true,
      );
      const page = await workbench();

      await expect
        .poll(() =>
          annotationTexts(page).then((labels) =>
            labels.some((label) => label.includes('…')),
          ),
        )
        .toBe(true);
      await configuration.update(
        'workbench.colorTheme',
        'Default Dark Modern',
        vscode.ConfigurationTarget.Global,
      );
      await expect
        .poll(() => vscode.window.activeColorTheme.kind)
        .toBe(vscode.ColorThemeKind.Dark);
      await page.screenshot({ path: '.artifacts/blame-native-dark.png' });
      await configuration.update(
        'workbench.colorTheme',
        'Default Light Modern',
        vscode.ConfigurationTarget.Global,
      );
      await expect
        .poll(() => vscode.window.activeColorTheme.kind)
        .toBe(vscode.ColorThemeKind.Light);
      await page.screenshot({ path: '.artifacts/blame-native-light.png' });
      await configuration.update(
        'editor.wordWrap',
        'on',
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand(
        'workbench.action.editorLayoutTwoColumns',
      );
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Two,
      });
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
      await page.screenshot({
        path: '.artifacts/blame-native-narrow-wrapped.png',
      });
      await vscode.commands.executeCommand('editor.foldAll');
      await page.screenshot({ path: '.artifacts/blame-native-folded.png' });
      assert.match(await fixture.runGit(['status', '--porcelain=v1']), /^$/);
    } finally {
      await configuration.update(
        'workbench.colorTheme',
        theme,
        vscode.ConfigurationTarget.Global,
      );
      await configuration.update(
        'editor.wordWrap',
        wrap,
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand(
        'workbench.action.editorLayoutSingle',
      );
      await fixture.dispose();
    }
  });
});
