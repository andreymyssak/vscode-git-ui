import styles from './FileTree.module.css';

export function FileTreeCheckbox({
  label,
  checked,
  mixed = false,
  disabled = false,
  tabIndex,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  tabIndex?: number;
  onChange(this: void, checked: boolean): void;
}) {
  return (
    <input
      type="checkbox"
      className={styles.checkbox}
      aria-label={label}
      tabIndex={tabIndex}
      checked={checked}
      disabled={disabled}
      ref={(input) => {
        if (input) input.indeterminate = mixed;
      }}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}
