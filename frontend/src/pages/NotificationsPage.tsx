import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellOff, CheckCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';
import { Button, Card, EmptyState, Page, PageHeader, Row, Text } from '../ui';
import { NotificationItem, type Notification } from '../components/NotificationItem';

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

  const unreadOnPage = notifications.filter(n => !n.read).length;

  return (
    <Page>
      <PageHeader
        title={t.notificationsTitle(total)}
        actions={unreadOnPage > 0 && (
          <Button icon={<CheckCheck />} onClick={handleMarkAllRead}>{t.markAllRead}</Button>
        )}
      />

      {loading ? (
        <Text tone="muted">{t.loading}</Text>
      ) : notifications.length === 0 ? (
        <EmptyState icon={<BellOff />} title={t.noNotifications} description={t.noNotificationsHint} />
      ) : (
        <>
          <Card flush>
            {notifications.map(n => (
              <NotificationItem
                key={n.id}
                notification={n}
                onHover={() => handleMarkRead(n.id)}
                onClick={() => navigate(`/sessions/${n.session_id}`)}
              />
            ))}
          </Card>

          {totalPages > 1 && (
            <Row gap={3} justify="center">
              <Button size="sm" icon={<ChevronLeft />} aria-label={t.previousPage} disabled={page <= 1} onClick={() => setPage(p => p - 1)} />
              <Text mono tone="muted" size="sm">{page} / {totalPages}</Text>
              <Button size="sm" icon={<ChevronRight />} aria-label={t.nextPage} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} />
            </Row>
          )}
        </>
      )}
    </Page>
  );
}
