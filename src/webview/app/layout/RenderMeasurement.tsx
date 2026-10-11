import { useLayoutEffect } from 'react';

import { RENDER_MEASUREMENT } from '@contracts/extension-identity';

import type { ViewState } from '../model/state';

export function RenderMeasurement({ snapshot }: { snapshot: ViewState }) {
  'use no memo';
  // eslint-disable-next-line react-hooks/purity -- This clock affects only post-commit telemetry, never rendered output.
  const start = performance.now();

  useLayoutEffect(() => {
    performance.clearMeasures(RENDER_MEASUREMENT);
    performance.measure(RENDER_MEASUREMENT, {
      start,
      end: performance.now(),
      detail: {
        repositoryId: snapshot.repository?.id ?? null,
        generation: snapshot.generation,
        loading: snapshot.loading,
        count: snapshot.commits.length,
        firstSha: snapshot.commits[0]?.sha ?? null,
        lastSha: snapshot.commits.at(-1)?.sha ?? null,
        nextCursor: snapshot.nextCursor,
        scrollTop: snapshot.scrollTop,
        selectedSha: snapshot.selectedSha,
      },
    });
  }, [snapshot, start]);

  return null;
}
