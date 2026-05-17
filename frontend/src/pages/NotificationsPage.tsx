import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useT, getLocale } from '../i18n';

interface Notification {
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

const PAGE_SIZE = 20;

export default function NotificationsPage() {
  const t = useT();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchNotifications = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const data = await api.getNotifications(p, PAGE_SIZE);
      setNotifications(data.notifications);
      setTotal(data.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchNotifications(page);
  }, [page, fetchNotifications]);

  const handleMarkRead = async (id: number) => {
    try {
      await api.markNotificationRead(id);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: 1 } : n));
    } catch { /* ignore */ }
  };

  const handleMarkAllRead = async () => {
    try {
      await api.markAllNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, read: 1 })));
    } catch { /* ignore */ }
  };

  const formatMessage = (n: Notification) => {
    const d = new Date(n.session_date + 'T00:00:00');
    const locale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
    const date = d.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    switch (n.type) {
      case 'invitation_confirmed': return t.notificationConfirmed(n.student_name, date);
      case 'invitation_declined': return t.notificationDeclined(n.student_name, date);
      case 'invitation_expired': return t.notificationExpired(n.student_name, date);
      case 'invitation_cancelled': return t.notificationCancelled(n.student_name, date);
      case 'session_full': return t.notificationSessionFull(date);
      case 'session_no_longer_full': return t.notificationSessionNoLongerFull(date);
    }
  };

  const getTimeAgo = (createdAt: string) => {
    const diff = Date.now() - new Date(createdAt + 'Z').getTime();
    const minutes = Math.floor(diff / 60000);
    return t.notificationTimeAgo(minutes);
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'invitation_confirmed': return '✓';
      case 'invitation_declined': return '✗';
      case 'invitation_expired': return '⏱';
      case 'invitation_cancelled': return '↩';
      case 'session_full': return '★';
      case 'session_no_longer_full': return '☆';
      default: return '•';
    }
  };

  const unreadOnPage = notifications.filter(n => !n.read).length;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t.notificationsTitle(total)}</h1>
        {unreadOnPage > 0 && (
          <button className="btn btn-outline btn-sm" onClick={handleMarkAllRead}>
            {t.markAllRead}
          </button>
        )}
      </div>

      {loading ? (
        <p>{t.loading}</p>
      ) : notifications.length === 0 ? (
        <div className="empty-state">
          <h3>{t.noNotifications}</h3>
          <p>{t.noNotificationsHint}</p>
        </div>
      ) : (
        <>
          <div className="notifications-list">
            {notifications.map(n => {
              const isSpecial = n.type === 'session_full' || n.type === 'session_no_longer_full';
              return (
              <div
                key={n.id}
                className={`notifications-list-item notification-clickable ${!n.read ? 'notification-unread' : ''} ${isSpecial ? 'notification-special notification-type-item-' + n.type : ''}`}
                onMouseEnter={() => { if (!n.read) handleMarkRead(n.id); }}
                onClick={() => navigate(`/sessions/${n.session_id}`)}
              >
                <span className={`notification-type-icon notification-type-${n.type.replace('invitation_', '')}`}>
                  {getTypeIcon(n.type)}
                </span>
                <div className="notification-content">
                  <span className="notification-message">{formatMessage(n)}</span>
                  <span className="notification-time">{getTimeAgo(n.created_at)}</span>
                </div>
              </div>
            );
            })}
          </div>

          {totalPages > 1 && (
            <div className="notifications-pagination">
              <button
                className="btn btn-outline btn-sm"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                ←
              </button>
              <span className="notifications-page-info">{page} / {totalPages}</span>
              <button
                className="btn btn-outline btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
