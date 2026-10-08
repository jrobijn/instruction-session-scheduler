import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api, API_BASE } from '../api';
import { useT } from '../i18n';
import { Button, Popover } from '../ui';
import { NotificationItem, type Notification } from './NotificationItem';
import styles from './NotificationBell.module.css';

export default function NotificationBell() {
  const t = useT();
  const navigate = useNavigate();
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const data = await api.getUnreadNotificationCount();
      setUnreadCount(data.count);
    } catch { /* ignore */ }
  }, []);

  const fetchRecent = useCallback(async () => {
    try {
      const data = await api.getNotifications(1, 10);
      setNotifications(data.notifications);
      setUnreadCount(data.notifications.filter((n: Notification) => !n.read).length > 0 ?
        (await api.getUnreadNotificationCount()).count : 0
      );
    } catch { /* ignore */ }
  }, []);

  // Initial load
  useEffect(() => {
    fetchUnreadCount();
  }, [fetchUnreadCount]);

  // SSE for real-time updates
  useEffect(() => {
    const evtSource = new EventSource(`${API_BASE}/notifications/events`, { withCredentials: true });
    evtSource.addEventListener('new_notification', (e) => {
      const data = JSON.parse(e.data);
      setUnreadCount(data.unread_count);
      setNotifications(prev => [data.notification, ...prev].slice(0, 10));
    });
    evtSource.addEventListener('unread_count_updated', (e) => {
      const data = JSON.parse(e.data);
      setUnreadCount(data.unread_count);
    });
    evtSource.onerror = () => { evtSource.close(); };
    return () => evtSource.close();
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (next) fetchRecent();
    setOpen(next);
  };

  const handleMarkRead = async (id: number) => {
    try {
      await api.markNotificationRead(id);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: 1 } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch { /* ignore */ }
  };

  const handleMarkAllRead = async () => {
    try {
      await api.markAllNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, read: 1 })));
      setUnreadCount(0);
    } catch { /* ignore */ }
  };

  const goTo = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      align="end"
      flush
      className={styles.panel}
      trigger={
        <button type="button" className={styles.bell} aria-label={t.notifications}>
          <Bell />
          {unreadCount > 0 && <span className={styles.count}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </button>
      }
    >
      <header className={styles.header}>
        <span className={styles.title}>{t.notifications}</span>
        {unreadCount > 0 && (
          <Button variant="ghost" size="sm" onClick={handleMarkAllRead}>{t.markAllRead}</Button>
        )}
      </header>
      <div className={styles.list}>
        {notifications.length === 0 ? (
          <p className={styles.empty}>{t.noNotifications}</p>
        ) : (
          notifications.map(n => (
            <NotificationItem
              key={n.id}
              notification={n}
              onHover={() => handleMarkRead(n.id)}
              onClick={() => goTo(`/sessions/${n.session_id}`)}
            />
          ))
        )}
      </div>
      <footer className={styles.footer}>
        <Button variant="ghost" size="sm" onClick={() => goTo('/notifications')}>{t.viewAllNotifications}</Button>
      </footer>
    </Popover>
  );
}
