import type { ReactNode } from 'react';
import { Check, Star, StarOff, Timer, Undo2, X } from 'lucide-react';
import { useT, getLocale } from '../i18n';
import { cx } from '../ui/cx';
import styles from './NotificationItem.module.css';

export interface Notification {
  id: number;
  type: 'invitation_confirmed' | 'invitation_declined' | 'invitation_expired' | 'invitation_cancelled' | 'session_full' | 'session_no_longer_full';
  invitation_id: number;
  session_id: number;
  student_name: string;
  session_date: string;
  timeslot_start_time: string | null;
  read: number;
  created_at: string;
}

const typeStyle: Record<Notification['type'], { icon: ReactNode; tone: 'success' | 'warning' | 'danger' }> = {
  invitation_confirmed: { icon: <Check />, tone: 'success' },
  invitation_declined: { icon: <X />, tone: 'danger' },
  invitation_expired: { icon: <Timer />, tone: 'warning' },
  invitation_cancelled: { icon: <Undo2 />, tone: 'danger' },
  session_full: { icon: <Star />, tone: 'success' },
  session_no_longer_full: { icon: <StarOff />, tone: 'warning' },
};

interface NotificationItemProps {
  notification: Notification;
  onHover: () => void;
  onClick: () => void;
}

export function NotificationItem({ notification: n, onHover, onClick }: NotificationItemProps) {
  const t = useT();
  const date = new Date(n.session_date + 'T00:00:00').toLocaleDateString(getLocale() === 'nl' ? 'nl-NL' : 'en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const message = {
    invitation_confirmed: () => t.notificationConfirmed(n.student_name, date),
    invitation_declined: () => t.notificationDeclined(n.student_name, date),
    invitation_expired: () => t.notificationExpired(n.student_name, date),
    invitation_cancelled: () => t.notificationCancelled(n.student_name, date),
    session_full: () => t.notificationSessionFull(date),
    session_no_longer_full: () => t.notificationSessionNoLongerFull(date),
  }[n.type]();
  const minutesAgo = Math.floor((Date.now() - new Date(n.created_at + 'Z').getTime()) / 60000);
  const { icon, tone } = typeStyle[n.type];

  return (
    <button
      type="button"
      className={cx(styles.item, !n.read && styles.unread)}
      onMouseEnter={() => { if (!n.read) onHover(); }}
      onClick={onClick}
    >
      <span className={cx(styles.icon, styles[tone])}>{icon}</span>
      <span className={styles.content}>
        <span className={styles.message}>{message}</span>
        <span className={styles.time}>{t.notificationTimeAgo(minutesAgo)}</span>
      </span>
    </button>
  );
}
