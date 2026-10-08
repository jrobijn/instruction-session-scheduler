import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown } from 'lucide-react';
import styles from './Table.module.css';
import { cx } from './cx';

export interface TableProps {
  /** Rows are clickable: pointer cursor + hover highlight. */
  interactive?: boolean;
  /** No outer border/radius, for use inside a flush Card. */
  embedded?: boolean;
  children: ReactNode;
}

/**
 * Write plain <thead>/<tbody>/<tr>/<th>/<td> inside.
 * Cell attributes: `data-numeric` (mono, right-aligned), `data-actions` (shrink, right-aligned).
 */
export function Table({ interactive, embedded, children }: TableProps) {
  return (
    <div className={cx(styles.wrap, embedded && styles.embedded)}>
      <table className={cx(styles.table, interactive && styles.interactive)}>{children}</table>
    </div>
  );
}

/** Chevron for the first cell of an expandable row. */
export function ExpandIcon({ expanded }: { expanded: boolean }) {
  return <ChevronRight className={cx(styles.expandIcon, expanded && styles.expanded)} aria-hidden />;
}

export interface SortHeaderProps {
  active: boolean;
  direction: 'asc' | 'desc';
  onSort: () => void;
  numeric?: boolean;
  /** Column takes only the width its content needs. */
  shrink?: boolean;
  children: ReactNode;
}

/** Clickable <th> for client-side sorting. */
export function SortHeader({ active, direction, onSort, numeric, shrink, children }: SortHeaderProps) {
  return (
    <th
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-numeric={numeric || undefined}
      data-shrink={shrink || undefined}
    >
      <button type="button" className={cx(styles.sortButton, active && styles.sortActive)} onClick={onSort}>
        {children}
        {active ? (direction === 'asc' ? <ChevronUp /> : <ChevronDown />) : <ChevronsUpDown />}
      </button>
    </th>
  );
}
