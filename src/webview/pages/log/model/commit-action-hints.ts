import type { LogData } from './view';

const fullIdentity = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

/** A loaded-data menu hint only. The host separately proves ancestry, cleanliness and publication. */
function canRewriteLoadedRange(
  data: Pick<LogData, 'repository' | 'commits' | 'refs' | 'commitRange'>,
  minimum: number,
  older = false,
): boolean {
  const { repository, commitRange, commits, refs } = data;
  const selected = new Set(commitRange.selectedShas);

  if (
    !repository?.branch ||
    !repository.headSha ||
    selected.size < minimum ||
    selected.size !== commitRange.selectedShas.length ||
    !commitRange.activeSha ||
    !selected.has(commitRange.activeSha) ||
    (!older && !selected.has(repository.headSha)) ||
    commitRange.selectedShas.some((sha) => !fullIdentity.test(sha)) ||
    refs.some((ref) => ref.kind === 'remote' && selected.has(ref.sha))
  )
    return false;

  const head = commits.find((commit) => commit.sha === repository.headSha);

  if (
    !head ||
    head.parents.length !== 1 ||
    !fullIdentity.test(head.parents[0]!)
  )
    return false;

  const loaded = new Map(commits.map((commit) => [commit.sha, commit]));
  const visited = new Set<string>();
  let current = repository.headSha;

  const remaining = new Set(selected);

  while (older ? remaining.size > 0 : selected.has(current)) {
    const commit = loaded.get(current);

    if (
      !commit ||
      visited.has(current) ||
      commit.parents.length !== 1 ||
      !fullIdentity.test(commit.parents[0]!)
    )
      return false;

    if (refs.some((ref) => ref.kind === 'remote' && ref.sha === current))
      return false;
    visited.add(current);
    remaining.delete(current);
    current = commit.parents[0]!;
  }

  return older ? remaining.size === 0 : visited.size === selected.size;
}

export function canSquashLoadedRange(
  data: Pick<LogData, 'repository' | 'commits' | 'refs' | 'commitRange'>,
): boolean {
  return canRewriteLoadedRange(data, 2, true);
}

export function canDropLoadedRange(
  data: Pick<LogData, 'repository' | 'commits' | 'refs' | 'commitRange'>,
): boolean {
  return canRewriteLoadedRange(data, 1);
}

export function canCherryPickLoadedRange(
  data: Pick<LogData, 'repository' | 'commits' | 'commitRange' | 'details'>,
  shas: readonly string[] = data.commitRange.selectedShas,
): boolean {
  const commits = new Map(data.commits.map((commit) => [commit.sha, commit]));

  if (data.details) commits.set(data.details.sha, data.details);

  return (
    !!data.repository?.branch &&
    shas.length > 0 &&
    shas.length <= 400 &&
    shas.every((sha) => (commits.get(sha)?.parents.length ?? 2) <= 1)
  );
}

export function canEditLoadedCommit(
  data: Pick<LogData, 'repository' | 'commits' | 'refs' | 'commitRange'>,
  sha: string,
): boolean {
  if (data.repository?.headSha === sha)
    return (
      !!data.repository.branch &&
      !data.refs.some((ref) => ref.kind === 'remote' && ref.sha === sha)
    );

  return canRewriteLoadedRange(
    {
      ...data,
      commitRange: { selectedShas: [sha], activeSha: sha, anchorSha: sha },
    },
    1,
    true,
  );
}
