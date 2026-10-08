import { cx } from '../ui/cx';
import styles from './StudentSearchResults.module.css';

interface StudentResult {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
}

interface StudentSearchResultsProps<T extends StudentResult> {
  results: T[];
  onSelect: (student: T) => void;
  /** Shown when there are no results; omit to render nothing. */
  emptyText?: string;
  /** Open above the input (near the bottom of the viewport). */
  up?: boolean;
}

/** Dropdown list under a student search input; the parent must be position: relative. */
export function StudentSearchResults<T extends StudentResult>({ results, onSelect, emptyText, up }: StudentSearchResultsProps<T>) {
  if (results.length === 0 && !emptyText) return null;
  return (
    <div className={cx(styles.results, up && styles.up)}>
      {results.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : results.map(s => (
        <button key={s.id} type="button" className={styles.result} onClick={() => onSelect(s)}>
          <span>{s.first_name} {s.last_name}</span>
          <span className={styles.email}>{s.email}</span>
        </button>
      ))}
    </div>
  );
}
