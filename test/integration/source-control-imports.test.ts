import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { expect, test } from 'vitest';

test.each([
  {
    from: 'source-control/service.ts',
    to: '../git/source-control/index',
    rule: null,
  },
  {
    from: 'native/commit-message.ts',
    to: '../git/source-control/index',
    rule: null,
  },
  {
    from: 'source-control/service.ts',
    to: '../git/source-control/backend',
    rule: 'source-control-git-public-api-only',
  },
  {
    from: 'native/commit-message.ts',
    to: '../git/source-control/selected-changes',
    rule: 'source-control-git-public-api-only',
  },
  {
    from: 'source-control/writes.ts',
    to: '../git/cli',
    rule: 'source-control-uses-git-backend',
  },
  {
    from: 'source-control/writes.ts',
    to: '../git/repository-operations',
    rule: 'source-control-uses-git-backend',
  },
  { from: 'git/source-control/backend.ts', to: '../cli', rule: null },
  {
    from: 'git/source-control/backend.ts',
    to: './selected-changes',
    rule: null,
  },
])('host import $from → $to', async ({ from, to, rule }) => {
  const root = await mkdtemp(join(tmpdir(), 'git-ui-host-import-'));

  try {
    const files: Record<string, string> = {
      'src/extension/git/source-control/index.ts':
        "export {value} from './backend';",
      'src/extension/git/source-control/backend.ts': 'export const value = 1;',
      'src/extension/git/source-control/selected-changes.ts':
        'export const value = 2;',
      'src/extension/git/cli.ts': 'export const value = 3;',
      'src/extension/git/repository-operations.ts': 'export const value = 4;',
    };

    files[`src/extension/${from}`] =
      `import * as value from '${to}'; export {value};`;
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }

    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
        'src',
        '--config',
        resolve('.dependency-cruiser.cjs'),
        '--output-type',
        'json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const validation = spawnSync(
      process.execPath,
      [
        resolve('node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
        'src',
        '--config',
        resolve('.dependency-cruiser.cjs'),
        '--output-type',
        'err',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const report = JSON.parse(result.stdout) as {
      summary: { violations: { rule: { name: string } }[] };
    };
    const rules = report.summary.violations.map(
      (violation) => violation.rule.name,
    );

    expect(result.error).toBeUndefined();
    expect(rules).not.toContain('not-to-unresolvable');
    if (rule) {
      expect(validation.status).not.toBe(0);
      expect(rules).toContain(rule);
    } else {
      expect(validation.status).toBe(0);
      expect(rules).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
