import type { SourceControlModel } from './model';
import { requireLiveRepository, type SourceControlRuntime } from './writes';

export async function toggleAmend({
  runtime,
  model,
  id,
  enabled,
  isCurrent = () => true,
}: {
  runtime: SourceControlRuntime;
  model: SourceControlModel;
  id: string;
  enabled: boolean;
  isCurrent?: () => boolean;
}): Promise<void> {
  if (!isCurrent() || model.busy) return;
  const repo = requireLiveRepository(runtime, model, id);

  if (!enabled) {
    model.setAmend(id, null);

    return;
  }

  const draft = model.draft(id);
  const mode = repo.commitMode;
  const unchanged = () =>
    isCurrent() &&
    !model.busy &&
    model.repositories.get(id)?.commitMode === mode &&
    model.draft(id) === draft;

  try {
    const commit = await runtime.access.repository(id).getCommit('HEAD');

    if (!unchanged()) return;
    const message = commit.message.trimEnd();

    requireLiveRepository(runtime, model, id);
    if (message.length > 65536)
      throw new Error(
        'The last commit message is too long for the commit editor.',
      );
    model.setAmend(id, {
      headSha: commit.hash,
      message,
    });
  } catch (error) {
    if (unchanged()) throw error;
  }
}
