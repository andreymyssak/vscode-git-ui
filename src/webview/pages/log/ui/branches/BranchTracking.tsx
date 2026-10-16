import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { useState } from 'react';

import type { Reference } from '@contracts/model';
import { Icon } from '@webview/shared/ui';

import styles from './BranchTracking.module.css';

export function BranchTracking({
  tracking,
  progress,
}: {
  tracking: Reference['tracking'];
  progress: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom',
    strategy: 'fixed',
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8, crossAxis: true }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, {
      move: false,
      delay: { open: 350 },
    }),
    useDismiss(context),
    useRole(context, { role: 'tooltip' }),
  ]);
  const counts = [
    tracking?.behind ? `${tracking.behind} incoming` : null,
    tracking?.ahead ? `${tracking.ahead} outgoing` : null,
  ].filter(Boolean);
  const total = (tracking?.behind ?? 0) + (tracking?.ahead ?? 0);
  const summary =
    progress ?? `${counts.join(' and ')} ${total === 1 ? 'commit' : 'commits'}`;

  return (
    <>
      <span
        ref={(node) => refs.setReference(node)}
        {...getReferenceProps()}
        slot="decoration"
        className={styles.tracking}
        aria-label={summary}
        title=""
      >
        {progress ? (
          <span className={styles.spinner}>
            <Icon name="loading" />
          </span>
        ) : tracking?.behind ? (
          <span data-incoming="" className={styles.incoming}>
            <Icon name="arrow-down" />
            {tracking.behind > 99 ? '99+' : tracking.behind}
          </span>
        ) : null}
        {!progress && tracking?.ahead ? (
          <span data-outgoing="" className={styles.outgoing}>
            <Icon name="arrow-up" />
            {tracking.ahead > 99 ? '99+' : tracking.ahead}
          </span>
        ) : null}
      </span>
      {open && (
        <FloatingPortal>
          <div
            ref={(node) => refs.setFloating(node)}
            {...getFloatingProps()}
            className={styles.tooltip}
            style={floatingStyles}
          >
            {summary}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
