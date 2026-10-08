import type { ReactNode } from 'react';
import styles from './DescriptionList.module.css';

export interface DescriptionItem {
  label: ReactNode;
  value: ReactNode;
}

/** Label/value pairs laid out in a responsive grid (detail panels, expanded rows). */
export function DescriptionList({ items, columns = 3, inline }: {
  items: DescriptionItem[];
  columns?: 1 | 2 | 3 | 4;
  /** One pair per row with the label beside the value (summaries). Ignores `columns`. */
  inline?: boolean;
}) {
  return (
    <dl className={inline ? styles.inline : styles.list} data-columns={inline ? undefined : columns}>
      {items.map((item, i) => (
        <div key={i} className={styles.item}>
          <dt className={styles.label}>{item.label}</dt>
          <dd className={styles.value}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
