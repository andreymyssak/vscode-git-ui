import { assert, expect, test } from 'vitest';

import type { ActionPrompts } from '../../src/extension/panel/actions';
import type { GitAction } from '../../src/shared/model';
import { a, fixture, page } from '../fixtures/controller';

for (const trustedAtClick of [true, false])
  test(`Update finishes before an optional checkout notification is answered, trusted=${trustedAtClick}`, async () => {
    let trusted = true;
    let choices: Parameters<
      NonNullable<ActionPrompts['reportUpdateBlocked']>
    >[1] = [];
    const f = fixture(true, true, {
      trusted: () => trusted,
      reportUpdateBlocked: (_message, actions) => {
        choices = actions;
      },
      reportActionError: async () =>
        assert.fail('The recovery notification already reports this error'),
    });
    const writes: GitAction[] = [];

    f.adapter.history = async () => ({
      ...page([a]),
      refs: [
        {
          ...page([]).refs[0]!,
          tracking: {
            upstream: 'refs/remotes/origin/main',
            ahead: 1,
            behind: 2,
          },
        },
      ],
    });
    f.adapter.operate = async (_id, action) => {
      writes.push(action);

      return action.kind === 'update-branch'
        ? {
            kind: 'error',
            backend: 'cli',
            message: 'Checkout is required.',
            updateDecision: {
              kind: 'checkout',
              continuation: {
                target: {
                  kind: 'update-branch',
                  refId: 'refs/heads/topic',
                  expectedSha: a,
                  expectedUpstream: 'refs/remotes/origin/main',
                },
                checkout: { ref: 'refs/heads/main', sha: a },
                fetchedSha: a,
                incomingCount: 2,
                remote: 'origin',
                remoteRef: 'refs/heads/main',
              },
            },
          }
        : { kind: 'success', backend: 'api' };
    };

    try {
      await f.controller.selectRepository('one');
      await f.controller.handle(
        f.request({
          kind: 'action',
          action: { kind: 'update-branch', refId: 'refs/heads/main' },
        }),
      );
      expect(choices.map((choice) => choice.label)).toEqual([
        'Checkout Branch',
      ]);
      expect(f.sent.at(-1)?.body).toEqual({
        kind: 'operation-progress',
        operation: null,
      });
      expect(writes).toHaveLength(1);
      trusted = trustedAtClick;
      await choices[0]!.run();
      expect(writes).toHaveLength(trustedAtClick ? 2 : 1);
      if (trustedAtClick)
        expect(writes[1]).toMatchObject({
          kind: 'continue-update',
          method: 'checkout',
          continuation: {
            target: { refId: 'refs/heads/topic', expectedSha: a },
          },
        });
      expect(f.sent.at(-1)?.body).toEqual({
        kind: 'operation-progress',
        operation: null,
      });
    } finally {
      f.controller.dispose();
    }
  });
