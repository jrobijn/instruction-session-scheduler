import type { ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';
import { useT } from '../i18n';
import { Button } from './Button';
import styles from './Dialog.module.css';
import { cx } from './cx';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned action buttons; put the primary action last. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  children?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, footer, size = 'md', children }: DialogProps) {
  const t = useT();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay}>
          <RadixDialog.Content
            className={cx(styles.content, styles[size])}
            {...(description ? {} : { 'aria-describedby': undefined })}
          >
            <header className={styles.header}>
              <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
              <RadixDialog.Close asChild>
                <Button variant="ghost" size="sm" icon={<X />} aria-label={t.close} />
              </RadixDialog.Close>
            </header>
            {description && <RadixDialog.Description className={styles.description}>{description}</RadixDialog.Description>}
            {children && <div className={styles.body}>{children}</div>}
            {footer && <footer className={styles.footer}>{footer}</footer>}
          </RadixDialog.Content>
        </RadixDialog.Overlay>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
