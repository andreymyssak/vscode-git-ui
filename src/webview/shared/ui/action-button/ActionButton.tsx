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
import { type ButtonHTMLAttributes, useId, useState } from 'react';

import { Icon } from '../icon/Icon';
import styles from './ActionButton.module.css';

export function ActionButton({
  label,
  icon,
  tooltip = label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: string;
  tooltip?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'right',
    strategy: 'fixed',
    middleware: [
      offset(6),
      flip({ fallbackAxisSideDirection: 'start' }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { move: false, delay: { open: 250 } }),
    useFocus(context),
    useDismiss(context),
    useRole(context, { role: 'tooltip' }),
  ]);

  return (
    <>
      <span
        className={styles.reference}
        ref={(node) => refs.setReference(node)}
        {...getReferenceProps()}
      >
        <button
          {...props}
          aria-label={label}
          aria-description={tooltip}
          aria-describedby={open ? id : undefined}
        >
          <Icon name={icon} />
        </button>
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
            {tooltip}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
