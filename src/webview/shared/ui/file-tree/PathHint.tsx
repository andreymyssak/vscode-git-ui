import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';

import styles from './FileTree.module.css';

export function PathHint({
  text,
  overflowOnly = false,
  delay = 500,
  children,
}: {
  text: string;
  overflowOnly?: boolean;
  delay?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = useRef<HTMLSpanElement>(null);
  const id = useId();
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      const clipped =
        !!label.current &&
        label.current.scrollWidth > label.current.clientWidth;

      setOpen(next && (!overflowOnly || clipped));
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(5), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { move: false, delay: { open: delay } }),
    useFocus(context),
    useDismiss(context),
    useRole(context, { role: 'tooltip' }),
  ]);

  return (
    <>
      <span
        className={styles.name}
        ref={(node) => {
          label.current = node;
          refs.setReference(node);
        }}
        {...getReferenceProps()}
        aria-describedby={open ? id : undefined}
      >
        {children}
      </span>
      {open && (
        <FloatingPortal>
          <div
            ref={(node) => refs.setFloating(node)}
            {...getFloatingProps()}
            id={id}
            className={styles.tooltip}
            style={floatingStyles}
          >
            {text}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
