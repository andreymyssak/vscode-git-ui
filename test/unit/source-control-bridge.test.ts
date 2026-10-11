import { expect, it } from 'vitest';

import type {
  SourceControlRequest,
  SourceControlResponse,
} from '../../src/shared/source-control';
import { createSourceControlBridge } from '../../src/webview/shared/api/source-control-bridge';

it('exchanges validated SCM messages and removes subscriptions on disposal', () => {
  const target = new EventTarget();
  const sent: SourceControlRequest[] = [];
  let saved: unknown = { tab: 'stash' };
  const bridge = createSourceControlBridge(
    {
      postMessage: (request) => sent.push(request),
      getState: () => saved,
      setState: (value) => {
        saved = value;
      },
    },
    target,
  );
  const received: SourceControlResponse[] = [];
  const response: SourceControlResponse = {
    kind: 'source-control-state',
    state: {
      hoverDelay: 500,
      repositories: [],
      repositoryId: null,
      tab: 'stash',
      busy: false,
      generating: false,
      reveal: null,
    },
  };

  bridge.subscribe((value) => received.push(value));
  target.dispatchEvent(
    new MessageEvent('message', {
      data: { kind: 'source-control-state', state: {} },
    }),
  );
  target.dispatchEvent(new MessageEvent('message', { data: response }));
  expect(received).toEqual([response]);
  bridge.send({ kind: 'refresh' });
  expect(sent).toEqual([{ kind: 'refresh' }]);
  bridge.setState({ tab: 'commit' });
  expect(bridge.getState()).toEqual({ tab: 'commit' });
  bridge.dispose();
  target.dispatchEvent(new MessageEvent('message', { data: response }));
  expect(received).toHaveLength(1);
  expect(() => bridge.send({ kind: 'refresh' })).toThrow(/disposed/);
});
