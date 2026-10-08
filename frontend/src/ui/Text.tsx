import type { ReactNode } from 'react';
import styles from './Text.module.css';
import { cx } from './cx';

export interface TextProps {
  as?: 'span' | 'p' | 'div';
  tone?: 'default' | 'muted' | 'subtle' | 'accent' | 'success' | 'warning' | 'danger';
  size?: 'xs' | 'sm' | 'md';
  weight?: 'regular' | 'medium' | 'semibold';
  /** Monospace with tabular figures — use for dates, times, counts, IDs. */
  mono?: boolean;
  /** Small uppercase label style. */
  label?: boolean;
  title?: string;
  children: ReactNode;
}

export function Text({ as: Tag = 'span', tone = 'default', size, weight, mono, label, title, children }: TextProps) {
  return (
    <Tag
      className={cx(styles[tone], size && styles[size], weight && styles[weight], mono && styles.mono, label && styles.label)}
      title={title}
    >
      {children}
    </Tag>
  );
}
