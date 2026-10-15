import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';

import type { Frame } from '@playwright/test';
import { expect } from '@playwright/test';
import * as vscode from 'vscode';
import { z } from 'zod';

import type { GitAdapter } from '../../src/extension/git/adapter';
import { createGitAdapter } from '../../src/extension/git/adapter';
import { getGitApi } from '../../src/extension/git/api';
import { LOG_VIEW_ID } from '../../src/shared/extension-identity';
import { createLargeHistory } from '../fixtures/large-history';
import { nativeBrowser } from '../fixtures/native-panel';

describe('large native history', () => {
  it('30k commits with merges keep 200-item pages, bounded rows and responsive loading', async function () {
    this.timeout(60000);
    const fixture = await createLargeHistory();
    const artifacts = process.env.GIT_UI_TEST_ARTIFACTS ?? '.artifacts';
    let adapter: GitAdapter | undefined;
    let frame: Frame | undefined;
    let filteredStart: number | undefined;

    try {
      adapter = await createGitAdapter();

      const total = Number(
        (await fixture.runGit(['rev-list', '--count', 'HEAD'])).trim(),
      );

      assert.ok(total >= 30000);
      assert.ok(
        Number(
          (
            await fixture.runGit([
              'rev-list',
              '--count',
              '--min-parents=2',
              'HEAD',
            ])
          ).trim(),
        ) > 0,
      );
      const access = await getGitApi();

      await access.api.openRepository(vscode.Uri.file(fixture.root));
      const id = vscode.Uri.file(fixture.root).toString();

      const start = performance.now();
      const first = await adapter.history(id, {
        scope: { kind: 'head' },
        text: '',
        cursor: null,
      });
      const gitPageMs = performance.now() - start;

      assert.equal(first.commits.length, 200);
      await vscode.commands.executeCommand(`${LOG_VIEW_ID}.focus`);
      const browser = await nativeBrowser();

      for (let attempt = 0; attempt < 100 && !frame; attempt++) {
        for (const page of browser.contexts().flatMap((c) => c.pages()))
          for (const candidate of page.frames())
            if (await candidate.locator('#branches').count()) frame = candidate;
        if (!frame) await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(frame);
      await expect(frame.locator('[data-commit-row]').first()).toHaveAttribute(
        'data-sha',
        first.commits[0]!.sha,
      );
      await frame.evaluate(() => {
        const times: number[] = [];
        const samples: unknown[] = [];
        const messages: unknown[] = [];

        Reflect.set(window, 'renderTimes', times);
        Reflect.set(window, 'renderSamples', samples);
        Reflect.set(window, 'historyMessages', messages);
        const recordMessage = (event: MessageEvent) => {
          const message = event.data as {
            generation?: number;
            requestId?: string;
            repositoryId?: string;
            body?: {
              kind?: string;
              message?: string;
              text?: string;
              scope?: unknown;
              page?: {
                commits: { sha: string }[];
                nextCursor: string | null;
              };
              append?: boolean;
              anchor?: unknown;
              sha?: string | null;
            };
          };

          if (
            [
              'loading',
              'history',
              'selection',
              'history-settled',
              'error',
            ].includes(message.body?.kind ?? '')
          )
            messages.push({
              time: performance.now(),
              generation: message.generation,
              requestId: message.requestId,
              repositoryId: message.repositoryId,
              kind: message.body?.kind,
              text: message.body?.text,
              scope: message.body?.scope,
              count: message.body?.page?.commits.length,
              nextCursor: message.body?.page?.nextCursor,
              firstSha: message.body?.page?.commits[0]?.sha,
              lastSha: message.body?.page?.commits.at(-1)?.sha,
              append: message.body?.append,
              anchor: message.body?.anchor,
              sha: message.body?.sha,
              error: message.body?.message,
            });
        };

        window.addEventListener('message', recordMessage);
        const record = (entries: readonly PerformanceEntry[]) => {
          for (const entry of entries)
            if (entry.name === 'git-ui-native.render') {
              times.push(entry.duration);
              samples.push({
                start: entry.startTime,
                duration: entry.duration,
                snapshot: (entry as PerformanceMeasure).detail,
              });
            }
        };

        const observer = new PerformanceObserver((list) =>
          record(list.getEntries()),
        );

        observer.observe({ entryTypes: ['measure'] });
        Reflect.set(window, 'drainPerformanceObservation', () =>
          record(observer.takeRecords()),
        );
        Reflect.set(window, 'stopPerformanceObservation', () => {
          record(observer.takeRecords());
          window.removeEventListener('message', recordMessage);
          observer.disconnect();
        });
      });
      await expect(frame.locator('#status')).not.toContainText('Loading');
      await expect(frame.locator('#history-pane')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect(frame.locator('#history')).not.toHaveAttribute('inert', '');
      const content = frame.locator('[data-history-content]');

      await expect(content).toHaveCSS('height', `${200 * 22}px`);
      for (let index = 1; index < 10; index++) {
        await expect(frame.locator('#history-pane')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        await expect(frame.locator('#history')).not.toHaveAttribute(
          'inert',
          '',
        );
        await frame.locator('#history').evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          // Deliver the gesture before deliberately racing a native refresh.
          node.dispatchEvent(new Event('scroll'));
        });
        // A native read can refresh unchanged HEAD while the next page is pending.
        if (index === 1) await access.repository(id).status();
        await expect(content)
          .toHaveCSS('height', `${(index + 1) * 200 * 22}px`)
          .catch(async (error: unknown) => {
            await writeFile(
              join(artifacts, 'native-history-failure.json'),
              JSON.stringify(
                await frame!.evaluate(() => ({
                  messages: Reflect.get(window, 'historyMessages'),
                  status: document.getElementById('status')?.textContent,
                  height: document
                    .querySelector('[data-history-content]')
                    ?.getBoundingClientRect().height,
                  scrollTop: document.getElementById('history')?.scrollTop,
                })),
                null,
                2,
              ),
            );
            throw error;
          });
      }

      const rows = await frame.locator('[data-commit-row]').count();

      assert.ok(rows <= 300);
      await frame
        .getByRole('searchbox', { name: 'Text or hash' })
        .fill('Large 10');
      filteredStart = performance.now();
      const loading = await frame.evaluate(async () => {
        const start = performance.now();
        const input = document.getElementById('search') as HTMLInputElement;

        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );

        return new Promise<{
          elapsed: number;
          text: string | null | undefined;
        }>((resolve) => {
          const sample = () => {
            const elapsed = performance.now() - start;
            const text = document.getElementById('status')?.textContent;

            if (text?.includes('Loading') || elapsed >= 100)
              resolve({ elapsed, text });
            else requestAnimationFrame(sample);
          };

          requestAnimationFrame(sample);
        });
      });

      // Restoring a deep anchor can read every matching Git page. Its completion
      // budget is separate from the 100 ms loading and rendering budgets below.
      await expect(frame.locator('#status')).not.toContainText('Loading', {
        timeout: 15000,
      });
      await expect(frame.locator('#history-pane')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect(frame.locator('#history')).not.toHaveAttribute('inert', '');
      await expect(content).toHaveCSS('height', `${1111 * 22}px`);

      const filteredHistoryMs = performance.now() - filteredStart;
      const measurements = await frame.evaluate(() => {
        const drain = Reflect.get(
          window,
          'drainPerformanceObservation',
        ) as () => void;

        drain();

        return {
          times: Reflect.get(window, 'renderTimes') as number[],
          samples: Reflect.get(window, 'renderSamples') as unknown[],
          messages: Reflect.get(window, 'historyMessages') as unknown[],
        };
      });
      const maxRenderMs = measurements.times.length
        ? Math.max(...measurements.times)
        : 0;
      const messages = z
        .array(
          z.object({
            kind: z.string(),
            generation: z.number().int(),
            requestId: z.string(),
            repositoryId: z.string(),
            text: z.string().optional(),
            count: z.number().int().optional(),
            nextCursor: z.string().nullable().optional(),
          }),
        )
        .parse(measurements.messages);
      const filteredLoading = [...messages]
        .reverse()
        .find(
          (message) =>
            message.kind === 'loading' && message.text === 'Large 10',
        );

      assert.ok(filteredLoading);
      const filtered = messages.filter(
        (message) =>
          message.generation === filteredLoading.generation &&
          message.requestId === filteredLoading.requestId &&
          message.repositoryId === id,
      );
      const pages = filtered.filter((message) => message.kind === 'history');

      assert.equal(
        filtered.some((message) => message.kind === 'error'),
        false,
      );
      assert.ok(filtered.some((message) => message.kind === 'history-settled'));
      assert.equal(
        pages.reduce((count, page) => count + (page.count ?? 0), 0),
        1111,
      );
      assert.equal(pages.at(-1)?.nextCursor, null);

      await writeFile(
        join(artifacts, 'performance.json'),
        JSON.stringify(
          {
            date: new Date().toISOString().slice(0, 10),
            os: platform(),
            release: release(),
            cpu: cpus()[0]?.model,
            vscode: vscode.version,
            node: process.versions.node,
            electron: process.versions.electron,
            totalCommits: total,
            firstPage: first.commits.length,
            tenPageMountedRows: rows,
            gitPageMs,
            loadingResponseMs: loading.elapsed,
            filteredHistoryMs,
            maxPostDataRenderMs: maxRenderMs,
            renderSamples: measurements.samples,
            historyMessages: measurements.messages,
          },
          null,
          2,
        ),
      );
      assert.ok(loading.elapsed <= 100);
      assert.ok(loading.text?.includes('Loading'));
      assert.ok(
        measurements.times.length > 0,
        'capture at least one post-data render',
      );
      assert.ok(maxRenderMs <= 100, `Post-data render ${maxRenderMs} ms`);
    } catch (error) {
      if (filteredStart !== undefined && frame && !frame.isDetached())
        await writeFile(
          join(artifacts, 'native-history-filter-failure.json'),
          JSON.stringify(
            {
              elapsedMs: performance.now() - filteredStart,
              snapshot: await frame.evaluate(() => ({
                messages: Reflect.get(window, 'historyMessages'),
                renders: Reflect.get(window, 'renderSamples'),
                filter: (document.getElementById('search') as HTMLInputElement)
                  .value,
                scope: document.getElementById('scope')?.textContent,
                status: document.getElementById('status')?.textContent,
                busy: document
                  .getElementById('history-pane')
                  ?.getAttribute('aria-busy'),
                inert: document
                  .getElementById('history')
                  ?.hasAttribute('inert'),
                height: document
                  .querySelector('[data-history-content]')
                  ?.getBoundingClientRect().height,
              })),
            },
            null,
            2,
          ),
        );
      throw error;
    } finally {
      try {
        if (frame && !frame.isDetached()) {
          await frame.evaluate(() => {
            const stop = Reflect.get(window, 'stopPerformanceObservation') as
              (() => void) | undefined;

            stop?.();
            Reflect.deleteProperty(window, 'stopPerformanceObservation');
            Reflect.deleteProperty(window, 'drainPerformanceObservation');
          });
          const search = frame.getByRole('searchbox', {
            name: 'Text or hash',
          });

          await search.fill('');
          await search.press('Enter');
          await expect(frame.locator('#history-pane')).toHaveAttribute(
            'aria-busy',
            'false',
          );
        }
      } finally {
        // The native driver owns the window and CDP lifetime; closing a connected
        // default context would also close its webview targets.
        adapter?.dispose();
        await fixture.dispose();
      }
    }
  });
});
