import type { ReactNode } from 'react';
import { Checkbox as RadixCheckbox } from 'radix-ui';
import { Check } from 'lucide-react';
import styles from './Checkbox.module.css';
import { cx } from './cx';

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
  /** Bordered, selectable card layout for option grids. */
  card?: boolean;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

export function Checkbox({ checked, onCheckedChange, label, description, card, disabled, id, 'aria-label': ariaLabel }: CheckboxProps) {
  const box = (
    <RadixCheckbox.Root
      id={id}
      className={styles.box}
      checked={checked}
      onCheckedChange={value => onCheckedChange(value === true)}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <RadixCheckbox.Indicator className={styles.indicator}>
        <Check />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
  if (!label) return box;
  return (
    <label className={cx(styles.label, card && styles.card, disabled && styles.disabled)}>
      {box}
      {description ? (
        <span className={styles.text}>
          <span className={styles.title}>{label}</span>
          <span className={styles.description}>{description}</span>
        </span>
      ) : (
        <span>{label}</span>
      )}
    </label>
  );
}
