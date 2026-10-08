import type { ComponentProps } from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import styles from './Tabs.module.css';
import { cx } from './cx';

export function Tabs({ className, ...rest }: ComponentProps<typeof RadixTabs.Root>) {
  return <RadixTabs.Root className={cx(styles.root, className)} {...rest} />;
}

export function TabList({ className, ...rest }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cx(styles.list, className)} {...rest} />;
}

export function Tab({ className, ...rest }: ComponentProps<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger className={cx(styles.tab, className)} {...rest} />;
}

export function TabPanel({ className, ...rest }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cx(styles.panel, className)} {...rest} />;
}
