import { expect, test, vi } from 'vitest';

import { GitCli } from '../../src/extension/git/cli';
import { createRepositoryAccess } from '../../src/extension/git/source-control/repository';
import { createFixture } from '../fixtures/repository';
import { squashAccess } from '../fixtures/squash-repository';

vi.mock('vscode', () => ({}));

test('background queue discovery is bounded without transferring cancellation to acquired writes', async () => {
  const fixture = await createFixture({ prefix: 'git-ui discovery scope ' });
  const access = squashAccess(fixture.root);
  const event = () => ({ dispose() {} });
  const repositories = createRepositoryAccess({
    ...access,
    repositories: () => [
      {
        id: 'fixture',
        label: 'fixture',
        rootUri: access.repository('fixture').rootUri.toString(),
        headSha: null,
        branch: 'main',
      },
    ],
    api: {
      ...access.api,
      onDidOpenRepository: event,
      onDidCloseRepository: event,
    },
  });
  const readOnly = vi.spyOn(GitCli.prototype, 'readOnly');
  const owner = new AbortController();

  try {
    const lease = repositories.lease('fixture');

    await lease.write(
      () => {},
      async (writer) => {
        owner.abort();
        await writer.run('fixture', [
          'config',
          'gitui.discovery-scope',
          'completed',
        ]);
      },
      { signal: owner.signal },
    );
    expect(readOnly).toHaveBeenCalledWith(owner.signal);
    expect(
      (
        await fixture.runGit(['config', '--get', 'gitui.discovery-scope'])
      ).trim(),
    ).toBe('completed');
  } finally {
    readOnly.mockRestore();
    repositories.dispose();
    await fixture.dispose();
  }
});
