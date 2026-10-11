import { expect, test } from '../fixtures/browser';

test('Strict Mode subscribes before ready without repeating it', async ({
  page,
}) => {
  await page.goto('/development.html');
  await expect(page.locator('[data-commit-row]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect(
    await page.evaluate(() => ({
      ready: window.__requests.filter(
        (request) => request.body.kind === 'ready',
      ).length,
      refresh: window.__requests.filter(
        (request) => request.body.kind === 'refresh',
      ).length,
      acquisitions: window.__acquisitions,
    })),
  ).toEqual({ ready: 1, refresh: 1, acquisitions: 1 });
  await page.evaluate(() =>
    window.__deliver({
      requestId: 'after-effects',
      repositoryId: 'one',
      generation: 1,
      body: { kind: 'reveal', sha: '2'.padStart(40, '0') },
    }),
  );
  await expect(
    page.locator('[data-sha="' + '2'.padStart(40, '0') + '"]'),
  ).toHaveAttribute('aria-selected', 'true');
});
test('pane drag cancellation releases ownership', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 280 });
  await page.goto('/');
  const divider = page.getByRole('separator', { name: 'Resize branches' });

  await divider.dispatchEvent('pointerdown', {
    button: 0,
    isPrimary: true,
    pointerId: 7,
    clientX: 220,
  });
  await divider.dispatchEvent('pointermove', { pointerId: 7, clientX: 250 });
  await divider.dispatchEvent('pointercancel', { pointerId: 7 });
  const value = await divider.getAttribute('aria-valuenow');

  await divider.dispatchEvent('pointermove', { pointerId: 7, clientX: 400 });
  await expect(divider).toHaveAttribute('aria-valuenow', value!);
});
test('virtualization retains a captured column handle', async ({ page }) => {
  await page.goto('/');
  const handle = page.getByRole('separator', {
    name: 'Resize Commit and Author columns',
  });
  const bounds = (await handle.boundingBox())!;

  await handle.evaluate((node) =>
    Reflect.set(window, 'capturedColumnHandle', node),
  );
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 12);
  await page.mouse.down();
  await page.locator('#history').evaluate((node) => {
    node.scrollTop = 1800;
  });
  await expect(
    page.locator('[data-commit-row][data-sha="' + '1'.padStart(40, '0') + '"]'),
  ).toHaveCount(0);
  expect(
    await handle.evaluate(
      (node) => node === Reflect.get(window, 'capturedColumnHandle'),
    ),
  ).toBe(true);
  await page.mouse.move(bounds.x + 25, bounds.y + 12);
  await page.mouse.up();
  expect(
    await handle.evaluate((node) => (node as HTMLElement).hasPointerCapture(1)),
  ).toBe(false);
});

test('scrolling a hovered row out of view removes its reference list', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .locator('[data-commit-row]')
    .first()
    .locator('[data-references]')
    .hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.locator('#history').evaluate((node) => {
    node.scrollTop = 1800;
  });
  await expect(
    page.locator('[data-sha="' + '1'.padStart(40, '0') + '"]'),
  ).toHaveCount(0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('a focused reference list follows its row when history scrolls', async ({
  page,
}) => {
  await page.goto('/');
  const references = page
    .locator('[data-sha="' + (10).toString(16).padStart(40, '0') + '"]')
    .locator('[data-references]');

  await references.focus();
  const tooltip = page.getByRole('tooltip');

  await expect(tooltip).toBeVisible();
  const before = (await tooltip.boundingBox())!.y;

  await page.locator('#history').evaluate((node) => {
    node.scrollTop = 22;
  });
  await expect
    .poll(async () => (await tooltip.boundingBox())?.y)
    .toBeCloseTo(before - 22, 0);
});
test('Strict Mode tree gestures send one scope and fetch request', async ({
  page,
}) => {
  await page.goto('/development.html');
  const topic = page.getByRole('treeitem', { name: 'topic', exact: true });

  await topic.click();
  await expect(topic).toHaveAttribute('aria-selected', 'true');
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (request) => request.body.kind === 'history',
    ),
  ).toHaveLength(0);
  await topic.press('Enter');
  await expect(page.locator('#scope')).toHaveText('topic');
  expect(
    (await page.evaluate(() => window.__requests)).filter(
      (request) => request.body.kind === 'history',
    ),
  ).toHaveLength(1);
  await page
    .getByRole('button', {
      name: 'Fetch All Remotes',
      exact: true,
    })
    .click();
  expect(
    (await page.evaluate(() => window.__requests))
      .filter((request) => request.body.kind === 'action')
      .map(({ body }) => body),
  ).toEqual([{ kind: 'action', action: { kind: 'fetch-all' } }]);
});

for (const path of ['/', '/development.html']) {
  const mode = path === '/' ? 'production' : 'Strict Mode';

  test(`${mode} cached document retains its mounted UI and live bridge without repeating ready or restore`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem(
        'git-ui-native-state',
        JSON.stringify({
          repositoryId: 'one',
          activeView: 'log',
          scope: { kind: 'head' },
          text: '',
          selectedRefId: null,
          selection: null,
          anchor: null,
          paneWidths: [220, 350],
        }),
      ),
    );
    await page.goto(path);
    await expect(page.locator('[data-commit-row]').first()).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__requests.filter(
              (request) => request.body.kind === 'restore',
            ).length,
        ),
      )
      .toBe(1);
    await page.evaluate(() =>
      Reflect.set(
        window,
        'cachedMount',
        document.querySelector('#app')!.firstElementChild,
      ),
    );
    const before = await page.evaluate(() => ({
      ready: window.__requests.filter(
        (request) => request.body.kind === 'ready',
      ).length,
      restore: window.__requests.filter(
        (request) => request.body.kind === 'restore',
      ).length,
      selections: window.__requests.filter(
        (request) => request.body.kind === 'select-commits',
      ).length,
      acquisitions: window.__acquisitions,
    }));

    for (let index = 0; index < 2; index++) {
      await page.evaluate(() => {
        window.dispatchEvent(
          new PageTransitionEvent('pagehide', { persisted: true }),
        );
        window.dispatchEvent(
          new PageTransitionEvent('pageshow', { persisted: true }),
        );
      });
      await expect(
        page.getByRole('tab', { name: 'Log', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.querySelector('#app')!.firstElementChild ===
            Reflect.get(window, 'cachedMount'),
        ),
      ).toBe(true);
    }

    const row = page.locator('[data-sha="' + '3'.padStart(40, '0') + '"]');

    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-commit-info]')).toContainText('Commit 3');
    expect(
      await page.evaluate(() => ({
        ready: window.__requests.filter(
          (request) => request.body.kind === 'ready',
        ).length,
        restore: window.__requests.filter(
          (request) => request.body.kind === 'restore',
        ).length,
        selections: window.__requests.filter(
          (request) => request.body.kind === 'select-commits',
        ).length,
        acquisitions: window.__acquisitions,
      })),
    ).toEqual({ ...before, selections: before.selections + 1 });
    await page.evaluate(() =>
      window.__deliver({
        ...window.__requests.at(-1)!,
        body: {
          kind: 'reveal',
          sha: '2'.padStart(40, '0'),
        },
      }),
    );
    await expect(
      page.locator('[data-sha="' + '2'.padStart(40, '0') + '"]'),
    ).toHaveAttribute('aria-selected', 'true');
  });

  for (const previouslyCached of [false, true]) {
    test(`${mode} permanent page unload releases the bridge and blocks late events${previouslyCached ? ' after a cached return' : ''}`, async ({
      page,
    }) => {
      await page.addInitScript(() => {
        const listeners = new Set<EventListenerOrEventListenerObject>();
        const add = window.addEventListener.bind(window);
        const remove = window.removeEventListener.bind(window);

        window.addEventListener = ((
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (type === 'message') listeners.add(listener);
          add(type, listener, options);
        }) as typeof window.addEventListener;
        window.removeEventListener = ((
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | EventListenerOptions,
        ) => {
          if (type === 'message') listeners.delete(listener);
          remove(type, listener, options);
        }) as typeof window.removeEventListener;
        Reflect.set(window, 'liveMessageListeners', listeners);
      });
      await page.goto(path);
      await expect(page.locator('[data-commit-row]').first()).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (Reflect.get(window, 'liveMessageListeners') as Set<unknown>).size,
        ),
      ).toBe(1);
      if (previouslyCached) {
        await page.evaluate(() => {
          window.dispatchEvent(
            new PageTransitionEvent('pagehide', { persisted: true }),
          );
          window.dispatchEvent(
            new PageTransitionEvent('pageshow', { persisted: true }),
          );
        });
        await expect(
          page.getByRole('tab', { name: 'Log', exact: true }),
        ).toBeVisible();
      }

      const before = await page.evaluate(() => window.__requests.length);

      await page.locator('#history').evaluate((node) => {
        Reflect.set(window, 'unloadingHistory', node);
        node.scrollTop = 44;
        node.dispatchEvent(new Event('scroll'));
      });
      expect(await page.evaluate(() => window.__requests.at(-1)?.body)).toEqual(
        { kind: 'anchor', anchor: { sha: '3'.padStart(40, '0'), offset: 0 } },
      );
      expect(await page.evaluate(() => window.__requests.length)).toBe(
        before + 1,
      );
      await page.evaluate(() =>
        window.dispatchEvent(
          new PageTransitionEvent('pagehide', { persisted: false }),
        ),
      );
      await expect(page.locator('#app')).toBeEmpty();
      expect(
        await page.evaluate(
          () =>
            (Reflect.get(window, 'liveMessageListeners') as Set<unknown>).size,
        ),
      ).toBe(0);
      await page.evaluate(() =>
        (Reflect.get(window, 'unloadingHistory') as HTMLElement).dispatchEvent(
          new Event('scroll'),
        ),
      );
      expect(await page.evaluate(() => window.__requests.length)).toBe(
        before + 1,
      );
      await page.evaluate(() =>
        window.__deliver({
          ...window.__requests.at(-1)!,
          body: { kind: 'reveal', sha: '2'.padStart(40, '0') },
        }),
      );
      await expect(page.locator('#app')).toBeEmpty();
      expect(await page.evaluate(() => window.__acquisitions)).toBe(1);
    });
  }
}
