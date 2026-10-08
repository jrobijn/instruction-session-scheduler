import type { ReactNode } from 'react';
import { RadioGroup } from 'radix-ui';
import styles from './RadioCards.module.css';

export interface RadioCardOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
}

export interface RadioCardsProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: RadioCardOption<T>[];
  'aria-label'?: string;
}

/** Single choice between a few options that need a description each. */
export function RadioCards<T extends string>({ value, onValueChange, options, 'aria-label': ariaLabel }: RadioCardsProps<T>) {
  return (
    <RadioGroup.Root className={styles.root} value={value} onValueChange={v => onValueChange(v as T)} aria-label={ariaLabel}>
      {options.map(option => (
        <label key={option.value} className={styles.card}>
          <RadioGroup.Item value={option.value} className={styles.radio}>
            <RadioGroup.Indicator className={styles.indicator} />
          </RadioGroup.Item>
          <span className={styles.text}>
            <span className={styles.label}>{option.label}</span>
            {option.description && <span className={styles.description}>{option.description}</span>}
          </span>
        </label>
      ))}
    </RadioGroup.Root>
  );
}
