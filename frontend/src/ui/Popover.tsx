import type { ReactElement, ReactNode } from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import styles from './Popover.module.css';
import { cx } from './cx';

export interface PopoverProps {
  /** Single element that can hold a ref (e.g. Button). */
  trigger: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Remove inner padding, e.g. for lists with their own header/footer. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function Popover({ trigger, open, onOpenChange, align = 'center', side = 'bottom', flush, className, children }: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={cx(styles.content, flush && styles.flush, className)}
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={8}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
