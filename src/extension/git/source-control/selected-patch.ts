import { MAX_SELECTED_PATCH_BYTES } from '../../../shared/commit-message';
import type { GitCli } from '../cli';
import { captureSelection, type SelectionSnapshot } from './selected-changes';
import type { WorkingFile } from './working-changes';
import { stageWorkingFiles } from './working-paths';

export { MAX_SELECTED_PATCH_BYTES } from '../../../shared/commit-message';

export interface SelectedPatch {
  readonly snapshot: SelectionSnapshot;
  readonly files: readonly WorkingFile[];
  readonly text: string;
}

function omitBinaryPayload(bytes: Buffer): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });

  return bytes
    .toString('latin1')
    .split(/(?=^diff --git )/m)
    .map((section) => {
      // Git normally emits binary metadata without --binary. Attributes can
      // force text output, so discard the complete body if it contains NUL
      // bytes or data that cannot be represented faithfully as UTF-8.
      const raw = Buffer.from(section, 'latin1');

      if (!raw.includes(0)) {
        try {
          return decoder.decode(raw);
        } catch {
          // Preserve file metadata, but never send a lossy decoded body.
        }
      }

      const metadata = section
        .split('\n')
        .filter((line) =>
          /^(?:diff --git |index |(?:new|deleted|old) (?:file )?mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) )/.test(
            line,
          ),
        );

      return `${Buffer.from(metadata.join('\n'), 'latin1').toString('utf8')}\nBinary or non-UTF-8 content omitted.\n`;
    })
    .join('');
}

export async function validateSelectedPatch(
  cli: GitCli,
  id: string,
  patch: SelectedPatch,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const current = await captureSelection(cli, id, patch.files);

  signal?.throwIfAborted();
  if (
    current.head !== patch.snapshot.head ||
    current.fingerprint !== patch.snapshot.fingerprint
  ) {
    throw new Error(
      'Checked files, HEAD, or staging changed. Refresh and generate the commit message again.',
    );
  }
}

export async function readSelectedPatch(
  cli: GitCli,
  id: string,
  files: readonly WorkingFile[],
  signal?: AbortSignal,
): Promise<SelectedPatch> {
  signal?.throwIfAborted();
  const selected = files.map((file) => ({ ...file }));
  const snapshot = await captureSelection(cli, id, selected);

  signal?.throwIfAborted();
  const text = await cli.withTemporaryIndex(id, async (index) => {
    signal?.throwIfAborted();
    await index.run(
      snapshot.head ? ['read-tree', snapshot.head] : ['read-tree', '--empty'],
    );
    const base = snapshot.head ?? (await index.run(['write-tree'])).trim();

    await stageWorkingFiles(
      index,
      (await cli.run(id, ['rev-parse', '--show-toplevel'], signal)).trim(),
      snapshot.paths,
      signal,
    );
    const tree = (await index.run(['write-tree'])).trim();
    const output = await cli
      .runBytes(
        id,
        [
          'diff',
          '--patch',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--full-index',
          '--find-renames',
          '--unified=3',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          base,
          tree,
          '--',
        ],
        signal,
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        )
          throw new Error(
            'The checked changes are too large to generate a commit message. Check fewer files or write the message manually.',
            { cause: error },
          );
        throw error;
      });

    signal?.throwIfAborted();

    return omitBinaryPayload(output);
  });
  const patch = { snapshot, files: selected, text };

  await validateSelectedPatch(cli, id, patch, signal);
  if (!text.trim())
    throw new Error(
      'The checked working files contain no changes to describe.',
    );
  if (Buffer.byteLength(text, 'utf8') > MAX_SELECTED_PATCH_BYTES)
    throw new Error(
      'The checked changes are too large to generate a commit message. Check fewer files or write the message manually.',
    );

  return patch;
}
