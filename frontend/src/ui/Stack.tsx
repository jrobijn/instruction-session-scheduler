import type { ReactNode } from 'react';
import styles from './Stack.module.css';
import { cx } from './cx';

type Gap = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8;

interface LayoutProps {
  gap?: Gap;
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  className?: string;
  children: ReactNode;
}

/** Vertical flow with token spacing. */
export function Stack({ gap = 4, align = 'stretch', justify = 'start', className, children }: LayoutProps) {
  return (
    <div className={cx(styles.stack, className)} data-gap={gap} data-align={align} data-justify={justify}>
      {children}
    </div>
  );
}

/** Horizontal flow with token spacing. */
export function Row({ gap = 2, align = 'center', justify = 'start', wrap, className, children }: LayoutProps & { wrap?: boolean }) {
  return (
    <div
      className={cx(styles.row, wrap && styles.wrap, className)}
      data-gap={gap}
      data-align={align}
      data-justify={justify}
    >
      {children}
    </div>
  );
}
