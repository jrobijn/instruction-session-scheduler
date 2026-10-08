import type { ComponentProps, ReactNode } from 'react';
import styles from './Button.module.css';
import { cx } from './cx';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  /** Lucide icon element. Icon-only buttons require an aria-label. */
  icon?: ReactNode;
  fullWidth?: boolean;
  /** Toggle button state (sets aria-pressed). */
  pressed?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', icon, fullWidth, pressed, className, children, type = 'button', ...rest }: ButtonProps) {
  const iconOnly = !!icon && (children === undefined || children === null || children === false);
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cx(styles.button, styles[variant], styles[size], iconOnly && styles.iconOnly, fullWidth && styles.fullWidth, pressed && styles.pressed, className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
