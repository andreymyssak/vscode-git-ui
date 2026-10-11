import { expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';

import {
  type CommitMessageModel,
  type CommitMessageProvider,
  draftCommitMessage,
} from '../../src/extension/native/commit-message-model';

class Cancellation implements vscode.CancellationToken {
  isCancellationRequested = false;
  private readonly listeners = new Set<() => unknown>();
  readonly onCancellationRequested: vscode.Event<void> = (listener) => {
    this.listeners.add(listener);

    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

async function* chunks(values: readonly string[]): AsyncIterable<string> {
  yield* values;
}

const patch = {
  files: [
    {
      path: 'checked.txt',
      originalPath: 'checked.txt',
      status: ' M',
      staged: false,
      working: true,
      untracked: false,
    },
  ],
  text: 'diff --git a/checked.txt b/checked.txt\n--- a/checked.txt\n+++ b/checked.txt\n@@ -1 +1 @@\n-old\n+current\n',
};

function setup(overrides: Partial<CommitMessageModel> = {}) {
  const token = new Cancellation();
  const validate = vi.fn(async () => {});
  const countTokens = vi.fn<CommitMessageModel['countTokens']>(async () => 100);
  const request = vi.fn<CommitMessageModel['request']>(async () =>
    chunks(['Update checked file\n', '\nUse current content.']),
  );
  const model = {
    id: 'fixture',
    name: 'Fixture',
    vendor: 'fixture',
    maxInputTokens: 4096,
    countTokens,
    request,
    ...overrides,
  } satisfies CommitMessageModel;
  const models = vi.fn(async () => [model]);
  const pick = vi.fn(async () => model);
  const provider: CommitMessageProvider = { models, pick };

  return {
    token,
    validate,
    model,
    provider,
    countTokens,
    request,
    models,
    pick,
  };
}

test('generation sends the complete checked patch after token count and validation, then returns an editable plain draft', async () => {
  const f = setup();

  expect(await draftCommitMessage({ patch, ...f })).toBe(
    'Update checked file\n\nUse current content.',
  );
  expect(f.models).toHaveBeenCalledOnce();
  expect(f.pick).not.toHaveBeenCalled();
  expect(f.countTokens).toHaveBeenCalledOnce();
  const [prompt, token] = f.countTokens.mock.calls[0] ?? [];

  expect(prompt).toContain(JSON.stringify(patch.text));
  expect(prompt).toContain('checked.txt');
  expect(prompt).toContain('Do not invent');
  expect(token).toBe(f.token);
  expect(f.request).toHaveBeenCalledWith(prompt, f.token);
  expect(f.validate).toHaveBeenCalledTimes(2);
  expect(f.token.listenerCount).toBe(0);
});

test('multiple available models require an explicit picker choice', async () => {
  const f = setup();
  const other = { ...f.model, id: 'other', name: 'Other' };

  f.models.mockResolvedValue([f.model, other]);
  f.pick.mockResolvedValue(other);
  await draftCommitMessage({ patch, ...f });
  expect(f.pick).toHaveBeenCalledWith([f.model, other], f.token);
});

test('no available model returns an actionable provider setup error without a request', async () => {
  const f = setup();

  f.models.mockResolvedValue([]);
  await expect(draftCommitMessage({ patch, ...f })).rejects.toThrow(
    /provider.*sign in/i,
  );
  expect(f.request).not.toHaveBeenCalled();
});

test('dismissing the model picker cancels generation without a request', async () => {
  const f = setup();
  const provider: CommitMessageProvider = {
    models: async () => [f.model, { ...f.model, id: 'other' }],
    pick: async () => undefined,
  };

  await expect(
    draftCommitMessage({ patch, ...f, provider }),
  ).rejects.toMatchObject({ name: 'Canceled' });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.token.listenerCount).toBe(0);
});

test('oversized inputs fail before model selection and do not silently omit checked files', async () => {
  const f = setup();

  await expect(
    draftCommitMessage({ patch: { ...patch, text: 'x'.repeat(300000) }, ...f }),
  ).rejects.toThrow(/too large.*fewer/i);
  expect(f.models).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

test('the model token limit prevents an oversized request without truncating its prompt', async () => {
  const f = setup({ maxInputTokens: 50 });

  await expect(draftCommitMessage({ patch, ...f })).rejects.toThrow(
    /token limit.*fewer.*larger/i,
  );
  expect(f.countTokens).toHaveBeenCalledOnce();
  expect(f.request).not.toHaveBeenCalled();
});

for (const [code, message] of [
  ['NoPermissions', /permission.*access/i],
  ['Blocked', /quota.*provider/i],
  ['NotFound', /no longer available.*another/i],
] as const) {
  test(`provider ${code} error has an actionable explanation`, async () => {
    const f = setup({
      request: async () => {
        throw Object.assign(new Error('Provider failed'), { code });
      },
    });

    await expect(draftCommitMessage({ patch, ...f })).rejects.toThrow(message);
    expect(f.token.listenerCount).toBe(0);
  });
}

test('stream failures discard partial model text', async () => {
  const f = setup({
    request: async () =>
      (async function* () {
        yield 'Partial draft';
        throw new Error('Disconnected');
      })(),
  });

  await expect(draftCommitMessage({ patch, ...f })).rejects.toThrow(
    /provider.*try again/i,
  );
});

test('cancellation stops waiting for model discovery and removes its listener', async () => {
  const f = setup();
  const provider: CommitMessageProvider = {
    models: () => new Promise(() => {}),
    pick: f.provider.pick,
  };
  const result = draftCommitMessage({ patch, ...f, provider });

  f.token.cancel();
  await expect(result).rejects.toMatchObject({ name: 'Canceled' });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.token.listenerCount).toBe(0);
});

test('cancellation during streamed output discards partial text', async () => {
  const f = setup();

  f.request.mockImplementation(async () =>
    (async function* () {
      yield 'Partial';
      f.token.cancel();
      yield ' stale text';
    })(),
  );
  await expect(draftCommitMessage({ patch, ...f })).rejects.toMatchObject({
    name: 'Canceled',
  });
  expect(f.token.listenerCount).toBe(0);
});

test('a selection changed while choosing the model fails validation before any request', async () => {
  const f = setup();

  f.validate.mockRejectedValue(new Error('Checked files changed.'));
  await expect(draftCommitMessage({ patch, ...f })).rejects.toThrow(
    /checked files changed/i,
  );
  expect(f.request).not.toHaveBeenCalled();
});

test('a selection changed during the model response rejects the draft', async () => {
  const f = setup();

  f.validate
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('Staging changed.'));
  await expect(draftCommitMessage({ patch, ...f })).rejects.toThrow(
    /staging changed/i,
  );
  expect(f.request).toHaveBeenCalledOnce();
});

test('an empty or unsafe model response fails without a draft', async () => {
  for (const value of [
    '  ',
    'Bad\0message',
    '```javascript\nexecute code\n```',
    'x'.repeat(9000),
  ]) {
    const f = setup({ request: async () => chunks([value]) });

    await expect(draftCommitMessage({ patch, ...f })).rejects.toThrow(
      /model.*(?:message|response)/i,
    );
  }
});

test('a complete plain-text fence is unwrapped into the editable message', async () => {
  const f = setup({
    request: async () => chunks(['```text\nUpdate checked file\n```']),
  });

  expect(await draftCommitMessage({ patch, ...f })).toBe('Update checked file');
});
