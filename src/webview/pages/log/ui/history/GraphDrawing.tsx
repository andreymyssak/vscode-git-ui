import { useLayoutEffect, useRef } from 'react';

import type { GraphRow } from '../../lib/graph/adapter';
import { renderGraph } from '../../lib/graph/rows';
import styles from './HistoryPane.module.css';

export function GraphDrawing({ row }: { row: GraphRow }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;

    if (!node) return;
    const drawing = renderGraph(row);

    node.append(drawing);

    return () => drawing.remove();
  }, [row]);

  return (
    <span
      ref={ref}
      data-commit-graph=""
      data-graph-kind={row.viewModel.kind}
      className={styles['commit-graph']}
    />
  );
}
