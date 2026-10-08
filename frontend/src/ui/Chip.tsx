import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './Chip.module.css';
import { cx } from './cx';

export interface ChipProps {
  /** Monospace label — times, codes. */
  mono?: boolean;
  /** Data colour (e.g. group colour) shown as a leading swatch. */
  swatch?: string;
  icon?: ReactNode;
  /** Shows a remove button. */
  onRemove?: () => void;
  removeLabel?: string;
  /** Extra inline icon buttons, rendered before the remove button. */
  actions?: Array<{ icon: ReactNode; label: string; onClick: () => void }>;
  title?: string;
  children: ReactNode;
}

/** Larger tag for entities in a set: timeslots, assigned instructors, etc. */
export function Chip({ mono, swatch, icon, onRemove, removeLabel, actions, title, children }: ChipProps) {
  return (
    <span className={cx(styles.chip, mono && styles.mono)} title={title}>
      {swatch && <span className={styles.swatch} style={{ background: swatch }} />}
      {icon}
      <span className={styles.label}>{children}</span>
      {actions?.map((action, i) => (
        <button key={i} type="button" className={styles.action} onClick={action.onClick} aria-label={action.label} title={action.label}>
          {action.icon}
        </button>
      ))}
      {onRemove && (
        <button type="button" className={styles.remove} onClick={onRemove} aria-label={removeLabel}>
          <X />
        </button>
      )}
    </span>
  );
}
