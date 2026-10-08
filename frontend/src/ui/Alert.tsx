import type { ReactNode } from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import styles from './Alert.module.css';
import { cx } from './cx';

type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const icons: Record<AlertTone, ReactNode> = {
  info: <Info />,
  success: <CircleCheck />,
  warning: <TriangleAlert />,
  danger: <CircleX />,
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  /** Trailing controls, e.g. a dismiss Button. */
  action?: ReactNode;
  children?: ReactNode;
}

export function Alert({ tone = 'info', title, action, children }: AlertProps) {
  return (
    <div className={cx(styles.alert, styles[tone])} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className={styles.icon}>{icons[tone]}</span>
      <div className={styles.content}>
        {title && <p className={styles.title}>{title}</p>}
        {children}
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
