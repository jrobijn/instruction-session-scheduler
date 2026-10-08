import type { ReactNode } from 'react';
import styles from './Card.module.css';
import { cx } from './cx';

export interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  /** Remove body padding, e.g. when the card wraps a Table. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function Card({ title, actions, flush, className, children }: CardProps) {
  return (
    <section className={cx(styles.card, className)}>
      {(title || actions) && (
        <header className={styles.header}>
          {title && <h2 className={styles.title}>{title}</h2>}
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={cx(styles.body, flush && styles.flush)}>{children}</div>
    </section>
  );
}
