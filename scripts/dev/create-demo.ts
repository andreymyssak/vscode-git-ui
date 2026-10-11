import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const artifacts = resolve('.artifacts');

await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(resolve(artifacts, 'graph-demo-'));
const root = resolve(directory, 'repository');
const remote = resolve(directory, 'remote.git');
const config = resolve(directory, 'gitconfig');

await mkdir(root);
await writeFile(config, '');
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  ),
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'John Smith',
  GIT_AUTHOR_EMAIL: 'john.smith@example.test',
  GIT_COMMITTER_NAME: 'John Smith',
  GIT_COMMITTER_EMAIL: 'john.smith@example.test',
  GIT_AUTHOR_DATE: '2026-09-01T10:00:00Z',
  GIT_COMMITTER_DATE: '2026-09-01T10:00:00Z',
};
const git = async (...args: string[]) =>
  (await execute('git', args, { cwd: root, env })).stdout.trim();

await git('init', '--initial-branch=main');
await git('config', 'user.name', env.GIT_AUTHOR_NAME);
await git('config', 'user.email', env.GIT_AUTHOR_EMAIL);
await git('config', 'commit.gpgsign', 'false');
await writeFile(
  resolve(root, 'README.md'),
  '# Tangled Git graph demo\n\nDisposable local data. Select All branches to see the complete history.\n',
);
await git('add', '.');
await git('commit', '-m', 'Start tangled graph demo');
const base = await git('rev-parse', 'HEAD');
const snapshots = new Map([
  [base, new Map([['README.md', await git('rev-parse', 'HEAD:README.md')]])],
]);
const content = resolve(directory, 'blob-content');
const indexEnv = {
  ...env,
  GIT_INDEX_FILE: resolve(directory, 'snapshot.index'),
};
const treeGit = async (...args: string[]) =>
  (await execute('git', args, { cwd: root, env: indexEnv })).stdout.trim();
let time = Date.parse('2026-09-01T10:00:00Z');
const commit = async (
  message: string,
  parents: readonly string[] = [],
  updates: readonly (readonly [string, string])[] = [],
): Promise<string> => {
  const snapshot = new Map(
    parents.flatMap((parent) => {
      const previous = snapshots.get(parent);

      if (!previous) throw new Error(`Missing demo parent snapshot: ${parent}`);

      return [...previous];
    }),
  );

  for (const [path, text] of updates) {
    await writeFile(content, text);
    snapshot.set(path, await git('hash-object', '-w', content));
  }

  await treeGit('read-tree', '--empty');
  if (snapshot.size)
    await treeGit(
      'update-index',
      '--add',
      ...[...snapshot].flatMap(([path, blob]) => [
        '--cacheinfo',
        `100644,${blob},${path}`,
      ]),
    );
  const tree = await treeGit('write-tree');

  time += 60000;
  const date = new Date(time).toISOString();
  const sha = (
    await execute(
      'git',
      [
        'commit-tree',
        tree,
        ...parents.flatMap((parent) => ['-p', parent]),
        '-m',
        message,
      ],
      {
        cwd: root,
        env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      },
    )
  ).stdout.trim();

  snapshots.set(sha, snapshot);

  return sha;
};

const ref = (name: string, sha: string) =>
  git('update-ref', `refs/heads/${name}`, sha);
let main = base;
const branches: string[] = [];

for (let cycle = 0; cycle < 6; cycle++) {
  const number = cycle + 1;
  let alpha = await commit(
    `API work ${number}`,
    [main],
    [
      [
        `packages/api/src/cycle-${number}.ts`,
        `export const apiCycle = ${number};\n`,
      ],
    ],
  );
  let beta = await commit(
    `UI work ${number}`,
    [main],
    [
      [
        `packages/ui/src/cycle-${number}.tsx`,
        `export const UiCycle = () => <div>Cycle ${number}</div>;\n`,
      ],
    ],
  );
  const alphaBeforeMerge = alpha;

  alpha = await commit(`API incorporates UI ${number}`, [alpha, beta]);
  beta = await commit(`UI incorporates API ${cycle + 1}`, [
    beta,
    alphaBeforeMerge,
  ]);
  // Two independent merge bases: a criss-cross history.
  const cross = await commit(
    `Integrate crossed work ${cycle + 1}`,
    [alpha, beta],
    [[`integration/cycle-${number}.txt`, `API and UI integration ${number}\n`]],
  );
  const docs = await commit(
    `Documentation ${number}`,
    [main],
    [[`docs/cycle-${number}.md`, `# Release cycle ${number}\n`]],
  );

  main = await commit(`Three-parent release integration ${cycle + 1}`, [
    main,
    cross,
    docs,
  ]);
  await ref(`feature/api-${cycle + 1}`, alpha);
  await ref(`feature/ui-${cycle + 1}`, beta);
  await ref(`release/cycle-${cycle + 1}`, main);
  branches.push(alpha, beta);
}

const feature = await commit(
  'Feature contents for empty-parent comparison',
  [main],
  [['examples/feature.txt', 'Feature included by the merge.\n']],
);
const emptyParent = await commit(
  'Merge with no changes compared with Parent 2',
  [main, feature],
);

await ref('examples/empty-second-parent', emptyParent);
await git('tag', 'examples/three-real-parents', main);
const side = await commit(
  'Start independent archive history',
  [],
  [['archive/README.md', '# Independent archive\n']],
);

await ref(
  'archive/independent-root',
  await commit(
    'Archive follow-up',
    [side],
    [['archive/notes.md', 'Archive notes.\n']],
  ),
);
// Import the repetitive linear history in one process instead of five per commit.
// The owned remote-tracking ref has the same final identity as the later fetch.
const maintenance: string[] = [];
const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;

for (let index = 0; index < 105; index++) {
  const blob = index * 2 + 1;
  const revision = blob + 1;

  time += 60000;
  const date = `${Math.floor(time / 1000)} +0000`;

  maintenance.push(
    `blob\nmark :${blob}\n` +
      data(`Maintenance revision ${index + 1}\n`) +
      `commit refs/remotes/origin/main\nmark :${revision}\n` +
      `author ${env.GIT_AUTHOR_NAME} <${env.GIT_AUTHOR_EMAIL}> ${date}\n` +
      `committer ${env.GIT_COMMITTER_NAME} <${env.GIT_COMMITTER_EMAIL}> ${date}\n` +
      data(`Incoming maintenance ${index + 1}\n`) +
      `from ${index === 0 ? main : `:${index * 2}`}\n` +
      `M 100644 :${blob} maintenance.txt\n\n`,
  );
}

const incoming = await new Promise<string>((resolveImport, rejectImport) => {
  const child = execFile(
    'git',
    ['fast-import', '--quiet', '--done'],
    { cwd: root, env },
    (error, stdout) => {
      if (error) rejectImport(new Error(error.message, { cause: error }));
      else resolveImport(stdout.trim());
    },
  );

  child.stdin?.on('error', rejectImport);
  child.stdin?.end(maintenance.join('') + 'get-mark :210\ndone\n');
});

await git('init', '--bare', remote);
await git('remote', 'add', 'origin', remote);
// Seed the owned bare remote directly; the demo generator never pushes.
await git('fetch', root, `${incoming}:refs/remotes/origin/main`);
await execute('git', ['fetch', root, `${incoming}:refs/heads/main`], {
  cwd: remote,
  env,
});
await execute(
  'git',
  ['fetch', root, `${main}:refs/heads/maintenance/behind-merge`],
  { cwd: remote, env },
);
await git('fetch', 'origin');
await ref('main', main);
await git('branch', '--set-upstream-to=origin/main', 'main');
const updateExamples = [
  {
    branch: 'maintenance/behind-one',
    tip: await git('rev-parse', `${incoming}^`),
    upstream: 'origin/main',
  },
  {
    branch: 'maintenance/behind-five',
    tip: await git('rev-parse', `${incoming}~5`),
    upstream: 'origin/main',
  },
  {
    branch: 'maintenance/behind-merge',
    tip: await git('rev-parse', 'release/cycle-5'),
    upstream: 'origin/maintenance/behind-merge',
  },
  {
    branch: 'maintenance/up-to-date',
    tip: incoming,
    upstream: 'origin/main',
  },
];

for (const { branch, tip, upstream } of updateExamples) {
  await ref(branch, tip);
  await git('branch', `--set-upstream-to=${upstream}`, branch);
}

await ref(
  'feature/diverged',
  await commit(
    'Local unpublished divergence',
    [main],
    [['local-feature.txt', 'Local unpublished work.\n']],
  ),
);
await git('branch', '--set-upstream-to=origin/main', 'feature/diverged');
for (let index = 0; index < 8; index++)
  await git('tag', `release/v1.${index}`, main);
for (const [index, sha] of branches.entries())
  await git('update-ref', `refs/remotes/origin/feature/topic-${index}`, sha);
await git('reset', '--hard', main);
const workspace = resolve(directory, 'Tangled Git Graph.code-workspace');

await writeFile(
  workspace,
  JSON.stringify(
    { folders: [{ path: root }], settings: { 'git.autofetch': false } },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify(
    {
      root,
      workspace,
      comparisonExamples: await Promise.all(
        [
          {
            name: 'Two-parent merge',
            sha: await git('rev-parse', 'feature/ui-4'),
          },
          { name: 'Three-parent merge', sha: main },
          { name: 'Empty second parent', sha: emptyParent },
        ].map(async ({ name, sha }) => ({
          name,
          sha,
          parents: await Promise.all(
            snapshots.has(sha)
              ? (await git('rev-parse', `${sha}^@`))
                  .split('\n')
                  .map(async (parentSha) => ({
                    parentSha,
                    files: (
                      await git('diff', '--name-only', parentSha, sha, '--')
                    )
                      .split('\n')
                      .filter(Boolean),
                  }))
              : [],
          ),
        })),
      ),
      updateExamples: await Promise.all(
        updateExamples.map(async ({ branch, upstream }) => {
          const [outgoing, incoming] = (
            await git(
              'rev-list',
              '--left-right',
              '--count',
              `${branch}...${upstream}`,
            )
          )
            .split(/\s+/)
            .map(Number);

          return { branch, upstream, incoming, outgoing };
        }),
      ),
      commits: Number(await git('rev-list', '--count', '--all')),
      mergeCommits: Number(
        await git('rev-list', '--count', '--min-parents=2', '--all'),
      ),
      branches: Number(
        await git(
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads',
          'refs/remotes',
        ).then((value) => value.split('\n').length),
      ),
    },
    null,
    2,
  ),
);
