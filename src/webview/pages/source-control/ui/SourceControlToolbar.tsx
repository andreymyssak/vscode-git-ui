import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { useState } from 'react';

import type { SourceControlOperation } from '@contracts/source-control';
import { operationPresentation } from '@contracts/source-control-operation';
import { ActionButton, FileTreeCheckbox } from '@webview/shared/ui';

import styles from './SourceControlPage.module.css';

type Props = {
  disabled: boolean;
  groupByDirectory: boolean;
  onRefresh(this: void): void;
  onGroupingChange(this: void, group: boolean): void;
  onExpand(this: void): void;
  onCollapse(this: void): void;
} & (
  | {
      kind: 'commit';
      operation: SourceControlOperation | null;
      onAbort(this: void): void;
      canStash: boolean;
      onStash(this: void): void;
      onReveal(this: void): void;
    }
  | {
      kind: 'stash';
      hasStashes: boolean;
      canApplyStash: boolean;
      onApplyStash(this: void): void;
    }
);

export function SourceControlToolbar(props: Props) {
  const { disabled, groupByDirectory, onGroupingChange, onExpand, onCollapse } =
    props;
  const section = props.kind === 'commit' ? 'Changes' : 'Stashes';
  const abort =
    props.kind === 'commit' && props.operation
      ? operationPresentation(props.operation.kind)
      : null;
  const treeDisabled =
    disabled || (props.kind === 'stash' && !props.hasStashes);
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'dialog' }),
  ]);

  return (
    <div
      role="toolbar"
      aria-label={`${section} actions`}
      className={styles.toolbar}
    >
      <ActionButton
        label="Refresh"
        icon="sync"
        className={styles.iconButton}
        disabled={disabled}
        onClick={props.onRefresh}
      />
      {props.kind === 'commit' ? (
        <ActionButton
          label="Stash Silently"
          tooltip="Stash checked files without a naming dialog"
          icon="archive"
          className={styles.iconButton}
          disabled={disabled || !props.canStash}
          onClick={props.onStash}
        />
      ) : (
        <ActionButton
          label="Apply Stash"
          tooltip="Restore the selected stash or its checked files, keeping the stash"
          icon="unarchive"
          className={styles.iconButton}
          disabled={disabled || !props.canApplyStash}
          onClick={props.onApplyStash}
        />
      )}
      <span ref={(node) => refs.setReference(node)}>
        <ActionButton
          label="View Options"
          tooltip={
            groupByDirectory
              ? 'View Options · Grouped by directory'
              : 'View Options · Flat list'
          }
          icon="eye"
          className={styles.iconButton}
          {...getReferenceProps()}
        />
      </span>
      {props.kind === 'commit' && (
        <ActionButton
          label="Select Opened File in Changes View"
          icon="target"
          className={styles.iconButton}
          disabled={disabled}
          onClick={props.onReveal}
        />
      )}
      <span className={styles.toolbarDivider} />
      <ActionButton
        label="Expand All"
        icon="expand-all"
        className={styles.iconButton}
        disabled={treeDisabled}
        onClick={onExpand}
      />
      <ActionButton
        label="Collapse All"
        icon="collapse-all"
        className={styles.iconButton}
        disabled={treeDisabled}
        onClick={onCollapse}
      />
      {props.kind === 'commit' && abort && (
        <span className={styles.abortAction}>
          <ActionButton
            label={abort.label}
            tooltip={`${abort.label}. ${abort.tooltip}`}
            icon="debug-stop"
            className={`${styles.iconButton} ${styles.abortButton}`}
            disabled={disabled}
            onClick={props.onAbort}
          />
        </span>
      )}
      {open && (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            modal={false}
            returnFocus={false}
          >
            <div
              ref={(node) => refs.setFloating(node)}
              {...getFloatingProps()}
              aria-label={`${section} view options`}
              className={styles.viewOptions}
              style={floatingStyles}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                setOpen(false);
                refs.domReference.current
                  ?.querySelector<HTMLButtonElement>('button')
                  ?.focus();
              }}
            >
              <label>
                <FileTreeCheckbox
                  label="Group by Directory"
                  checked={groupByDirectory}
                  onChange={onGroupingChange}
                />
                Group by Directory
              </label>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  );
}
