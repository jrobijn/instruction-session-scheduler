import type { ReactNode } from 'react';
import { CalendarClock, Clock, Send, Timer } from 'lucide-react';
import { useT } from '../i18n';
import { Badge, Row, type Tone } from '../ui';
import styles from './StatusBadges.module.css';

const sessionStatus: Record<string, { tone: Tone; icon?: ReactNode }> = {
  draft: { tone: 'neutral' },
  scheduled: { tone: 'info', icon: <Clock /> },
  invitations_sent: { tone: 'info', icon: <Send /> },
  completed: { tone: 'success' },
  cancelled: { tone: 'danger' },
};

const invitationStatus: Record<string, { tone: Tone; icon?: ReactNode }> = {
  scheduled: { tone: 'neutral', icon: <CalendarClock /> },
  invited: { tone: 'warning', icon: <Clock /> },
  confirmed: { tone: 'success' },
  declined: { tone: 'danger' },
  cancelled: { tone: 'danger' },
  admin_cancelled: { tone: 'danger' },
  expired: { tone: 'danger', icon: <Timer /> },
  invalidated: { tone: 'danger', icon: <Timer /> },
};

export function SessionStatusBadge({ status }: { status: string }) {
  const t = useT();
  const { tone, icon } = sessionStatus[status] ?? sessionStatus.cancelled;
  return <Badge tone={tone} icon={icon}>{t.statusMap(status)}</Badge>;
}

export function InvitationStatusBadge({ status }: { status: string }) {
  const t = useT();
  const { tone, icon } = invitationStatus[status] ?? { tone: 'warning' as Tone, icon: <Clock /> };
  return <Badge tone={tone} icon={icon}>{t.statusMap(status)}</Badge>;
}

/** Group name with its colour swatch. */
export function GroupLabel({ name, color }: { name: string; color?: string | null }) {
  return (
    <Row gap={2}>
      <span className={styles.swatch} style={{ background: color || undefined }} />
      <span>{name}</span>
    </Row>
  );
}
