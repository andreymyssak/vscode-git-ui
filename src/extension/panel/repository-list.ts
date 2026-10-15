import type { PanelBody } from '../../shared/messages';
import type { GitAdapter } from '../git/adapter';

/** Coalesce native lifecycle callbacks even when setup yields during replacement. */
export function createRepositoryList(options: {
  adapter(this: void): GitAdapter | null;
  setup(this: void): Promise<boolean>;
  current(this: void): boolean;
  selected(this: void): string;
  clear(this: void): void;
  send(this: void, body: PanelBody): Promise<void>;
  select(this: void, id: string): Promise<void>;
}) {
  let epoch = 0;

  return async () => {
    const owner = ++epoch;

    const adapter = options.adapter();

    if (
      !(await options.setup()) ||
      !options.current() ||
      owner !== epoch ||
      !adapter
    )
      return;
    const repositories = adapter.repositories();

    if (!repositories.length) {
      options.clear();
      await options.send({
        kind: 'setup',
        state: 'no-repository',
        message: 'Open a folder containing a Git repository.',
        repositories: [],
      });

      return;
    }

    await options.send({
      kind: 'setup',
      state: 'ready',
      message: '',
      repositories,
    });
    if (!options.current() || owner !== epoch) return;
    if (!repositories.some((repo) => repo.id === options.selected())) {
      const first = repositories[0];

      if (first) await options.select(first.id);
    }
  };
}
