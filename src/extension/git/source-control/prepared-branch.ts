import { updateCheckout } from '../branch-update-target';
import type { BeforeWrite, RepositoryLease } from './repository';

export async function prepareBranchCreation(
  lease: RepositoryLease,
  id: string,
) {
  const checkout = await updateCheckout(lease.cli, id);

  return {
    write({ name, beforeWrite }: { name: string; beforeWrite: BeforeWrite }) {
      return lease.write(beforeWrite, async (cli) => {
        if (!name || name.startsWith('-'))
          throw new Error('Enter a valid branch name.');
        await cli.run(id, ['check-ref-format', '--branch', name]);
        const current = await updateCheckout(cli, id);

        if (current.ref !== checkout.ref || current.sha !== checkout.sha)
          throw new Error(
            'The current branch or HEAD changed. Try New Branch again.',
          );
        await lease.current().createBranch(name, false, checkout.sha);
      });
    },
  };
}
