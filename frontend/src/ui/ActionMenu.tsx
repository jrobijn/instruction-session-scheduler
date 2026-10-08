import type { ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Ellipsis } from 'lucide-react';
import { useT } from '../i18n';
import { Button } from './Button';
import styles from './ActionMenu.module.css';
import { cx } from './cx';

export interface ActionMenuItem {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  danger?: boolean;
}

/** Row-level "⋯" menu. Safe inside clickable table rows (stops propagation). */
export function ActionMenu({ actions }: { actions: ActionMenuItem[] }) {
  const t = useT();
  if (actions.length === 0) return null;

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" icon={<Ellipsis />} aria-label={t.actions} onClick={e => e.stopPropagation()} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={styles.content} align="end" sideOffset={4} onClick={e => e.stopPropagation()}>
          {actions.map((a, i) => (
            <DropdownMenu.Item key={i} className={cx(styles.item, a.danger && styles.danger)} onSelect={a.onClick}>
              {a.icon}
              {a.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
