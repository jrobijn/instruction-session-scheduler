import type { ReactNode } from 'react';
import { Check, Info, TriangleAlert, X } from 'lucide-react';
import styles from './Badge.module.css';
import { cx } from './cx';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const defaultIcons: Partial<Record<Tone, ReactNode>> = {
  success: <Check />,
  warning: <TriangleAlert />,
  danger: <X />,
  info: <Info />,
};

export interface BadgeProps {
  tone?: Tone;
  /** Defaults to a tone-specific icon for status tones; pass `false` to hide. */
  icon?: ReactNode | false;
  /** Monospace, non-uppercase — for counts, ratios and times. */
  mono?: boolean;
  title?: string;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', icon, mono, title, children }: BadgeProps) {
  const shownIcon = icon === false ? null : (icon ?? defaultIcons[tone]);
  return (
    <span className={cx(styles.badge, styles[tone], mono && styles.mono)} title={title}>
      {shownIcon}
      {children}
    </span>
  );
}
