import type { ReactNode } from 'react';
import { ToggleGroup } from 'radix-ui';
import styles from './SegmentedControl.module.css';

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
  'aria-label'?: string;
}

export function SegmentedControl<T extends string>({ value, onValueChange, options, ...rest }: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      className={styles.root}
      value={value}
      // Radix emits '' when the active item is clicked again; keep one option selected
      onValueChange={v => { if (v) onValueChange(v as T); }}
      {...rest}
    >
      {options.map(o => (
        <ToggleGroup.Item key={o.value} value={o.value} className={styles.item}>{o.label}</ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
