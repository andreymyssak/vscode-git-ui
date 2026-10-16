import { expect, onTestFinished, test } from 'vitest';

import type { PanelBody, RequestBody, Result } from '../../src/shared/messages';
import type { HistoryInput, Selection } from '../../src/shared/model';
import type { ViewState } from '../../src/webview/app/model/state';
import { initialView, reduceView } from '../../src/webview/app/model/state';
import { fixture, page } from '../fixtures/controller';

const shas = Array.from({ length: 600 }, (_, index) =>
  (index + 1).toString(16).padStart(40, '0'),
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  onTestFinished(resolve);

  return { promise, resolve };
}

function harness() {
  let state = initialView();
  let sequence = 0;
  const cursors = new Map<string, number>();
  const reads: number[] = [];
  const messages: Result<PanelBody>[] = [];
  const publications: Array<{
    count: number;
    loading: boolean;
  }> = [];
  let observe: (message: Result<PanelBody>) => Promise<void> = async () => {};

  let beforeRead: (
    input: HistoryInput,
    offset: number,
  ) => Promise<void> = async () => {};

  const f = fixture(true, true, {
    send: async (message) => {
      state = reduceView(state, { kind: 'host', message });
      messages.push(message);
      if (message.body.kind === 'history')
        publications.push({
          count: state.commits.length,
          loading: state.loading,
        });
      await observe(message);
    },
  });

  onTestFinished(() => f.controller.dispose());

  f.adapter.history = async (_id, input) => {
    const offset = input.cursor ? cursors.get(input.cursor)! : 0;
    const request = ++sequence;

    reads.push(offset);
    await beforeRead(input, offset);
    const cursor =
      offset + 200 < shas.length ? `cursor-${offset + 200}-${request}` : null;

    if (cursor) cursors.set(cursor, offset + 200);

    return { ...page(shas.slice(offset, offset + 200)), nextCursor: cursor };
  };

  const request = (body: RequestBody) =>
    f.controller.handle(f.request(body, 'one', state.generation));
  const history = () =>
    request({
      kind: 'history',
      scope: state.scope,
      text: state.text,
      filters: state.filters,
      cursor: state.nextCursor,
    });
  const restore = (index: number) => {
    const sha = (index + 1).toString(16).padStart(40, '0');
    const selection: Selection = { sha, parentSha: null, filePath: 'safe.txt' };

    return request({
      kind: 'restore',
      scope: state.scope,
      text: state.text,
      filters: state.filters,
      selection,
      anchor: { sha, offset: 9 },
    });
  };

  return {
    ...f,
    reads,
    messages,
    publications,
    cursors,
    request,
    history,
    restore,
    get state() {
      return state;
    },
    update(patch: Partial<ViewState>) {
      state = { ...state, ...patch };
    },
    select(sha: string) {
      state = reduceView(state, { kind: 'select-commit', sha });
    },
    observe(callback: typeof observe) {
      observe = callback;
    },
    beforeRead(callback: typeof beforeRead) {
      beforeRead = callback;
    },
  };
}

test('deep refresh has one paging owner and cannot rewind a terminal cursor', async () => {
  const h = harness();

  await h.controller.selectRepository('one');
  await h.history();
  await h.history();
  const sha = shas[500]!;

  h.select(sha);
  h.update({ scrollTop: 500 * 22 + 9 });
  await h.request({ kind: 'select-commits', shas: [sha], activeSha: sha });
  await h.request({ kind: 'open-file', fileId: `one-${sha}`, preview: true });
  await h.request({ kind: 'anchor', anchor: { sha, offset: 9 } });
  const entered = deferred();
  const gate = deferred();
  const clients: Promise<void>[] = [];
  let blocked = false;

  h.reads.length = 0;
  h.beforeRead(async (_input, offset) => {
    if (offset === 200 && !blocked) {
      blocked = true;
      entered.resolve();
      await gate.promise;
    }
  });
  h.observe(async (message) => {
    if (
      message.body.kind !== 'history' ||
      h.state.loading ||
      !h.state.nextCursor ||
      h.state.scrollTop + 200 < h.state.commits.length * 22 - 200
    )
      return;
    h.update({ loading: true });
    clients.push(h.history());
    // Let the first client read claim the cursor before reload resumes.
    await entered.promise;
  });
  const refresh = h.controller.refresh();

  // A restoring read also uses the gate after the fix; let it finish normally.
  await entered.promise;
  if (clients.length === 0) gate.resolve();
  await refresh;
  gate.resolve();
  await Promise.all(clients);
  expect(h.reads).toStrictEqual([0, 200, 400]);
  expect(h.state.commits.length).toBe(600);
  expect(h.state.nextCursor).toBe(null);
  expect(h.state.loading).toBe(false);
  expect(h.state.selectedSha).toBe(sha);
  expect(h.state.selectedFilePath).toBe('safe.txt');
  expect(h.state.scrollTop).toBe(500 * 22 + 9);
});
test('partial restoration retains the next unread cursor and releases paging after selection and files', async () => {
  const h = harness();

  await h.controller.selectRepository('one');
  h.reads.length = 0;
  h.publications.length = 0;
  await h.restore(350);
  expect(h.reads).toStrictEqual([0, 200]);
  expect(h.publications).toStrictEqual([{ count: 400, loading: true }]);
  expect(h.cursors.get(h.state.nextCursor!)).toBe(400);
  expect(h.state.loading).toBe(false);
  expect(h.state.selectedSha).toBe(shas[350]);
  expect(h.state.selectedFilePath).toBe('safe.txt');
  expect(h.state.scrollTop).toBe(350 * 22 + 9);
  expect(h.state.files.root?.length).toBe(1);
});
test('restoring a missing commit stops at the terminal page and clears stale selection', async () => {
  const h = harness();

  await h.controller.selectRepository('one');
  h.reads.length = 0;
  h.publications.length = 0;
  await h.restore(700);
  expect(h.reads).toStrictEqual([0, 200, 400]);
  expect(h.publications.every((publication) => publication.loading)).toBe(true);
  expect(h.state.nextCursor).toBe(null);
  expect(h.state.loading).toBe(false);
  expect(h.state.selectedSha).toBe(null);
  expect(h.state.anchor).toBe(null);
});
test.each(['resolves', 'rejects'])(
  'a newer navigation retains its own cursor when the old restoration page %s',
  async (outcome) => {
    const h = harness();
    const entered = deferred();
    const gate = deferred();

    await h.controller.selectRepository('one');
    h.reads.length = 0;
    h.beforeRead(async (_input, offset) => {
      if (offset === 200) {
        entered.resolve();
        await gate.promise;
        if (outcome === 'rejects')
          throw new Error('Old restoration page failed');
      }
    });
    const restore = h.restore(500);

    await entered.promise;
    const busy = h.state.loading;
    const sha = shas[2]!;

    h.adapter.resolve = async () => ({
      kind: 'commit',
      commit: page([sha]).commits[0]!,
    });
    await h.request({ kind: 'go-to', input: sha });
    const details = h.state.details;
    const files = h.state.files;

    gate.resolve();
    await restore;
    expect(h.state.error).toBe(null);
    expect(busy).toBe(true);
    expect(h.reads).toStrictEqual([0, 200, 0]);
    expect(h.state.selectedSha).toBe(sha);
    expect(h.state.details).toBe(details);
    expect(h.state.files).toBe(files);
    expect(h.cursors.get(h.state.nextCursor!)).toBe(200);
    expect(h.state.loading).toBe(false);
  },
);
test('a restoration read error leaves the published cursor available for a later client read', async () => {
  const h = harness();
  let fail = true;

  await h.controller.selectRepository('one');
  h.publications.length = 0;
  h.beforeRead(async (_input, offset) => {
    if (offset === 200 && fail) throw new Error('Page unavailable');
  });
  await h.restore(350);
  expect(h.publications).toStrictEqual([{ count: 200, loading: true }]);
  expect(h.state.loading).toBe(false);
  expect(h.state.error).toBe('Page unavailable');
  expect(h.cursors.get(h.state.nextCursor!)).toBe(200);
  fail = false;
  await h.history();
  expect(h.state.commits.length).toBe(400);
  expect(h.cursors.get(h.state.nextCursor!)).toBe(400);
  expect(h.state.error).toBe(null);
});
test('an obsolete restoration cannot settle a newer query while its first page is pending', async () => {
  const h = harness();
  const oldEntered = deferred();
  const oldGate = deferred();
  const newEntered = deferred();
  const newGate = deferred();

  await h.controller.selectRepository('one');
  h.beforeRead(async (input, offset) => {
    if (input.text === 'new') {
      newEntered.resolve();
      await newGate.promise;
    } else if (offset === 200) {
      oldEntered.resolve();
      await oldGate.promise;
    }
  });
  const restore = h.restore(500);

  await oldEntered.promise;
  const oldGeneration = h.state.generation;
  const fresh = h.request({
    kind: 'history',
    scope: h.state.scope,
    text: 'new',
    cursor: null,
  });

  await newEntered.promise;
  oldGate.resolve();
  await restore;
  expect(h.state.generation).toBe(oldGeneration + 1);
  expect(h.state.loading).toBe(true);
  expect(h.state.commits.length).toBe(0);
  expect(h.state.text).toBe('new');
  newGate.resolve();
  await fresh;
  expect(h.state.loading).toBe(false);
  expect(h.state.commits.length).toBe(200);
});
