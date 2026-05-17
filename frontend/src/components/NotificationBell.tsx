import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, API_BASE } from '../api';
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

export default function NotificationBell() {
  const t = useT();
  const navigate = useNavigate();
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
    evtSource.onerror = () => { evtSource.close(); };
    return () => evtSource.close();
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = () => {
    if (!open) fetchRecent();
    setOpen(prev => !prev);
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

  return (
    <div className="notification-bell" ref={dropdownRef}>
      <button className="notification-bell-btn" onClick={handleOpen} aria-label={t.notifications}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notification-dropdown">
          <div className="notification-dropdown-header">
            <span className="notification-dropdown-title">{t.notifications}</span>
            {unreadCount > 0 && (
              <button className="notification-mark-all-btn" onClick={handleMarkAllRead}>
                {t.markAllRead}
              </button>
            )}
          </div>

          <div className="notification-dropdown-list">
            {notifications.length === 0 ? (
              <div className="notification-empty">{t.noNotifications}</div>
            ) : (
              notifications.map(n => {
                const isSpecial = n.type === 'session_full' || n.type === 'session_no_longer_full';
                return (
                <div
                  key={n.id}
                  className={`notification-item notification-clickable ${!n.read ? 'notification-unread' : ''} ${isSpecial ? 'notification-special notification-type-item-' + n.type : ''}`}
                  onMouseEnter={() => { if (!n.read) handleMarkRead(n.id); }}
                  onClick={() => { setOpen(false); navigate(`/sessions/${n.session_id}`); }}
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
              })
            )}
          </div>

          <div className="notification-dropdown-footer">
            <button
              className="notification-view-all-btn"
              onClick={() => { setOpen(false); navigate('/notifications'); }}
            >
              {t.viewAllNotifications}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
