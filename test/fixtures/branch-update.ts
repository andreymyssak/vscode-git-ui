import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { getGitApi } from '../../src/extension/git/api';
import { createFixture } from './repository';

export async function divergentFixture(branch: string, conflict = false) {
  const fixture = await createFixture({
    prefix: 'git-ui-native-divergent-update-',
  });
  const remote = fixture.root + '-remote.git';

  try {
    const base = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

    await fixture.runGit(['init', '--bare', remote]);
    await fixture.runGit(['remote', 'add', 'origin', remote]);
    const publish = async (sha: string) =>
      fixture.runGit([
        '--git-dir',
        remote,
        'fetch',
        fixture.root,
        `${sha}:refs/heads/main`,
      ]);

    await publish(base);
    await fixture.runGit(['fetch', 'origin']);
    if (branch !== 'main') await fixture.runGit(['checkout', '-b', branch]);
    await fixture.runGit(['branch', '--set-upstream-to=origin/main', branch]);
    await writeFile(
      join(fixture.root, conflict ? 'sample.txt' : 'local.txt'),
      'local change\n',
    );
    await fixture.runGit(['add', '.']);
    await fixture.runGit(['commit', '-m', 'Local work']);
    const local = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

    await fixture.runGit(['checkout', '--detach', base]);
    await writeFile(
      join(fixture.root, conflict ? 'sample.txt' : 'remote.txt'),
      'remote change\n',
    );
    await fixture.runGit(['add', '.']);
    await fixture.runGit(['commit', '-m', 'Remote work']);
    const incoming = (await fixture.runGit(['rev-parse', 'HEAD'])).trim();

    await publish(incoming);
    await fixture.runGit(['checkout', 'main']);
    // Fetch is done by Update, so its initial upstream is still the old base.
    const id = vscode.Uri.file(fixture.root).toString();
    const access = await getGitApi();

    await access.api.openRepository(vscode.Uri.file(fixture.root));
    await access.repository(id).status();

    return {
      ...fixture,
      base,
      local,
      incoming,
      remote,
      id,
      access,
      action: {
        kind: 'update-branch' as const,
        refId: `refs/heads/${branch}`,
        expectedSha: local,
        expectedUpstream: 'refs/remotes/origin/main',
      },
      async dispose() {
        if (
          access.api.repositories.some(
            (repository) => repository.rootUri.toString() === id,
          )
        )
          await vscode.commands.executeCommand(
            'git.close',
            vscode.Uri.file(fixture.root),
          );
        await Promise.all([
          fixture.dispose(),
          rm(remote, { recursive: true, force: true }),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([
      fixture.dispose(),
      rm(remote, { recursive: true, force: true }),
    ]);
    throw error;
  }
}
