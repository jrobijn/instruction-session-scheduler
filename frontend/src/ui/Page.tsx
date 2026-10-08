import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from './Button';
import styles from './Page.module.css';

export function Page({ children }: { children: ReactNode }) {
  return <main className={styles.page}>{children}</main>;
}

/** Full-height centred column for standalone screens (login, invitation). */
export function CenteredPage({ children }: { children: ReactNode }) {
  return <main className={styles.centered}>{children}</main>;
}

export interface PageHeaderProps {
  title: ReactNode;
  /** Back link shown above the title on detail pages. */
  back?: { label: string; onClick: () => void };
  /** Inline next to the title, e.g. status badges. */
  meta?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, back, meta, actions }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      {back && (
        <div className={styles.back}>
          <Button variant="ghost" size="sm" icon={<ArrowLeft />} onClick={back.onClick}>{back.label}</Button>
        </div>
      )}
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{title}</h1>
        {meta && <div className={styles.meta}>{meta}</div>}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </header>
  );
}
