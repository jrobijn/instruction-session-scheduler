import type { ReactElement, ReactNode } from 'react';
import { Tooltip as RadixTooltip } from 'radix-ui';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Must be a single element that can hold a ref (e.g. Button, span). */
  children: ReactElement;
}

export function Tooltip({ content, side = 'top', children }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className={styles.content} side={side} sideOffset={6}>
            {content}
            <RadixTooltip.Arrow className={styles.arrow} />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
