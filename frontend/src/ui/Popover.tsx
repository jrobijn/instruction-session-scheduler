import { useRef, type ReactElement, type ReactNode } from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import styles from './Popover.module.css';
import { cx } from './cx';

export interface PopoverProps {
  /** Single element that can hold a ref (e.g. Button). */
  trigger?: ReactElement;
  /** Positions the popover against this element without toggling it; use with controlled `open`. */
  anchor?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Remove inner padding, e.g. for lists with their own header/footer. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function Popover({ trigger, anchor, open, onOpenChange, align = 'center', side = 'bottom', flush, className, children }: PopoverProps) {
  const opener = useRef<HTMLElement | null>(null);
  const interactedOutside = useRef(false);
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>}
      {anchor && <RadixPopover.Anchor asChild>{anchor}</RadixPopover.Anchor>}
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={cx(styles.content, flush && styles.flush, className)}
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            interactedOutside.current = false;
          }}
          onInteractOutside={() => { interactedOutside.current = true; }}
          onCloseAutoFocus={e => {
            // Without a trigger Radix has nothing to restore focus to, so return it to whatever opened the popover
            if (trigger || interactedOutside.current || !opener.current?.isConnected) return;
            e.preventDefault();
            opener.current.focus();
          }}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
