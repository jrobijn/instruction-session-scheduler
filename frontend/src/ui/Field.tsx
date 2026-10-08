import type { ComponentProps, ReactNode } from 'react';
import DatePicker from 'react-datepicker';
import { CalendarDays, ChevronDown } from 'lucide-react';
import styles from './Field.module.css';
import { cx } from './cx';

export interface FieldProps {
  label: ReactNode;
  /** id of the control, for label association. */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <div className={styles.hint}>{hint}</div>}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cx(styles.control, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx(styles.control, styles.textarea, className)} {...rest} />;
}

/** Native colour picker rendered as a swatch. */
export function ColorInput({ className, ...rest }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input type="color" className={cx(styles.color, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <span className={styles.adorned}>
      <select className={cx(styles.control, styles.select, className)} {...rest}>
        {children}
      </select>
      <ChevronDown className={styles.trailingIcon} aria-hidden />
    </span>
  );
}

export interface DateInputProps {
  id?: string;
  selected: Date | null;
  onChange: (date: Date | null) => void;
  filterDate?: (date: Date) => boolean;
  minDate?: Date;
  maxDate?: Date;
  dateFormat?: string;
  placeholderText?: string;
  disabled?: boolean;
}

export function DateInput(props: DateInputProps) {
  return (
    <span className={styles.adorned}>
      <DatePicker {...props} className={cx(styles.control, styles.date)} />
      <CalendarDays className={styles.trailingIcon} aria-hidden />
    </span>
  );
}
