import styles from './ProgressBar.module.css';

export function ProgressBar({ active }: { active: boolean }) {
  return active ? <div className={styles.bar} aria-hidden="true" /> : null;
}
