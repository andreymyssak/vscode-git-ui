type RecoveryResult = { kind: 'success' } | { kind: 'error'; error: unknown };

/** Shares recovery scans without interrupting their owned cleanup work. */
export function createRecoveryScheduler({
  reconcile,
  publish,
}: {
  reconcile: () => Promise<void>;
  publish: (result: RecoveryResult) => void;
}) {
  let pending: Promise<void> | null = null;
  let dirty = false;
  let closed = false;
  const schedule = () => {
    if (pending || closed) return;
    pending = Promise.resolve()
      .then(async () => {
        while (dirty && !closed) {
          dirty = false;
          let result: RecoveryResult;

          try {
            await reconcile();
            result = { kind: 'success' };
          } catch (error) {
            result = { kind: 'error', error };
          }

          if (!closed) publish(result);
        }
      })
      .finally(() => {
        pending = null;
        if (dirty && !closed) schedule();
      });
  };

  return {
    async reconcile() {
      if (closed) return;
      dirty = true;
      schedule();
      // A new request can land as a pass finishes. Explicit preparation must
      // also wait for the replacement promise scheduled by that finalizer.
      while (pending && !closed) await pending;
    },
    dispose() {
      closed = true;
      dirty = false;
    },
  };
}
