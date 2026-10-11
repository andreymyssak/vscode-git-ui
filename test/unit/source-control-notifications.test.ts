import { expect, test } from 'vitest';

import { SourceControlNotifications } from '../../src/extension/source-control/notifications';

test('repeated background failures notify once per resource, and recovery allows a later failure to notify again', () => {
  const messages: string[] = [];
  const notifications = new SourceControlNotifications((message) =>
    messages.push(message),
  );
  const failure = {
    kind: 'error',
    message: 'Unable to read Git status',
  } as const;

  notifications.load('repo', 'changes', 'Changes', failure);
  notifications.load('repo', 'changes', 'Changes', failure);
  notifications.load('repo', 'changes', 'Changes', { kind: 'loading' });
  expect(messages).toEqual(['Changes: Unable to read Git status']);
  notifications.load('repo', 'stashes', 'Stashes', failure);
  notifications.load('repo', 'changes', 'Changes', {
    kind: 'ready',
    items: [],
  });
  notifications.load('repo', 'changes', 'Changes', failure);
  expect(messages).toEqual([
    'Changes: Unable to read Git status',
    'Stashes: Unable to read Git status',
    'Changes: Unable to read Git status',
  ]);
});

test('connection recovery, closed repositories and an explicit retry reset failure notifications', () => {
  const messages: string[] = [];
  const notifications = new SourceControlNotifications((message) =>
    messages.push(message),
  );
  const failure = { kind: 'error', message: 'Unavailable' } as const;

  notifications.connection('Git disabled');
  notifications.connection('Git disabled');
  notifications.connection(null);
  notifications.connection('Git disabled');
  notifications.load('repo', 'changes', 'Changes', failure);
  notifications.retainRepositories(new Set());
  notifications.load('repo', 'changes', 'Changes', failure);
  notifications.reset();
  notifications.load('repo', 'changes', 'Changes', failure);
  expect(messages).toEqual([
    'Git disabled',
    'Git disabled',
    'Changes: Unavailable',
    'Changes: Unavailable',
    'Changes: Unavailable',
  ]);
});
