import { Slider as RadixSlider } from 'radix-ui';
import styles from './Slider.module.css';

export interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  'aria-label'?: string;
}

export function Slider({ value, onValueChange, min = 0, max = 100, step = 1, disabled, 'aria-label': ariaLabel }: SliderProps) {
  return (
    <RadixSlider.Root
      className={styles.root}
      value={[value]}
      onValueChange={([v]) => onValueChange(v)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
    >
      <RadixSlider.Track className={styles.track}>
        <RadixSlider.Range className={styles.range} />
      </RadixSlider.Track>
      <RadixSlider.Thumb className={styles.thumb} aria-label={ariaLabel} />
    </RadixSlider.Root>
  );
}
