import { useLayoutEffect } from 'react';

import { RENDER_MEASUREMENT } from '@contracts/extension-identity';

import type { BrowserSession } from '../model/browser-session';
import { useBrowserSelector } from '../model/useBrowserState';

export function RenderMeasurement({
  store,
}: {
  store: BrowserSession['store'];
}) {
  'use no memo';
  const snapshot = useBrowserSelector(store, (state) => ({
    repositoryId: state.repository?.id ?? null,
    generation: state.generation,
    loading: state.loading,
    count: state.commits.length,
    firstSha: state.commits[0]?.sha ?? null,
    lastSha: state.commits.at(-1)?.sha ?? null,
    nextCursor: state.nextCursor,
    scrollTop: state.scrollTop,
    selectedSha: state.selectedSha,
  }));
  // eslint-disable-next-line react-hooks/purity -- This clock affects only post-commit telemetry, never rendered output.
  const start = performance.now();

  useLayoutEffect(() => {
    performance.clearMeasures(RENDER_MEASUREMENT);
    performance.measure(RENDER_MEASUREMENT, {
      start,
      end: performance.now(),
      detail: snapshot,
    });
  }, [snapshot, start]);

  return null;
}
