import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Mail, Plus } from 'lucide-react';
import { api, API_BASE } from '../api';
import { useT, getLocale } from '../i18n';
import {
  ActionMenu, Alert, Badge, Button, DateInput, Dialog, EmptyState, Field,
  Page, PageHeader, Row, Select, Stack, Table, Text, useConfirm, useToast,
} from '../ui';
import { SessionStatusBadge } from '../components/StatusBadges';
import styles from './SessionsPage.module.css';

interface Session {
  id: number;
  date: string;
  status: string;
  timetable_id: number | null;
  timetable_name: string | null;
  instructor_count: number;
  invitation_count: number;
  confirmed_count: number;
  total_slots: number;
}

interface Timetable {
  id: number;
  name: string;
  is_default: number;
}

function parseDate(dateStr: string) {
  return new Date(dateStr + 'T00:00:00');
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [clubDays, setClubDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [showModal, setShowModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedTimetable, setSelectedTimetable] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();

  const load = async () => {
    try {
      const [sess, tts, settingsData] = await Promise.all([api.getSessions(), api.getTimetables(), api.getSettings()]);
      setSessions(sess);
      const available = tts.filter((t: any) => t.status === 'saved' && t.active);
      setTimetables(available);
      const cd = (settingsData.club_days || '0|1|2|3|4|5|6').split('|').map(Number);
      setClubDays(cd);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // SSE: real-time session count updates
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/sessions/events`, { withCredentials: true });
    es.addEventListener('session_counts_updated', (e) => {
      const data = JSON.parse(e.data);
      setSessions(prev => prev.map(s =>
        s.id === data.session_id
          ? { ...s, invitation_count: data.invitation_count, confirmed_count: data.confirmed_count }
          : s
      ));
    });
    return () => es.close();
  }, []);

  const isClubDay = (d: Date) => clubDays.includes(d.getDay());

  const openCreateModal = () => {
    setError('');
    setSelectedDate(null);
    const defaultTt = timetables.find(t => t.is_default);
    setSelectedTimetable(defaultTt ? String(defaultTt.id) : '');
    setShowModal(true);
  };

  const handleCreate = async () => {
    if (!selectedDate) return;
    setError('');
    const dateStr = selectedDate.getFullYear() + '-' + String(selectedDate.getMonth() + 1).padStart(2, '0') + '-' + String(selectedDate.getDate()).padStart(2, '0');
    try {
      const session = await api.createSession({
        date: dateStr,
        timetable_id: selectedTimetable ? Number(selectedTimetable) : undefined,
      });
      setShowModal(false);
      setSelectedDate(null);
      navigate(`/sessions/${session.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm({ title: t.delete, message: t.confirmDeleteSession, confirmLabel: t.delete, danger: true })) return;
    try {
      await api.deleteSession(id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;

  const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';

  return (
    <Page>
      <PageHeader
        title={t.sessionsTitle(sessions.length)}
        actions={<Button variant="primary" icon={<Plus />} onClick={openCreateModal}>{t.newSession}</Button>}
      />

      {sessions.length === 0 ? (
        <EmptyState icon={<CalendarDays />} title={t.noSessionsYet} description={t.noSessionsHint} />
      ) : (
        <Table interactive>
          <thead>
            <tr>
              <th>{t.date}</th>
              <th>{t.status}</th>
              <th>{t.timetable}</th>
              <th data-numeric>{t.instructors}</th>
              <th>{t.invitations}</th>
              <th data-actions>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map(s => {
              const date = parseDate(s.date);
              const showFill = s.total_slots > 0 && (s.status === 'invitations_sent' || s.status === 'completed');
              const isFull = s.status === 'completed' || s.confirmed_count >= s.total_slots;
              return (
                <tr key={s.id} onClick={() => navigate(`/sessions/${s.id}`)}>
                  <td>
                    <Row gap={3} align="baseline">
                      <Text mono weight="medium">
                        {date.toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', year: 'numeric' })}
                      </Text>
                      <Text tone="muted" size="sm">{date.toLocaleDateString(dateLocale, { weekday: 'long' })}</Text>
                    </Row>
                  </td>
                  <td>
                    <SessionStatusBadge status={s.status} />
                  </td>
                  <td>{s.timetable_name || <Text tone="subtle">{t.noData}</Text>}</td>
                  <td data-numeric>{s.instructor_count}</td>
                  <td>
                    <Row gap={2}>
                      <span className={styles.countSlot}>
                        {s.invitation_count > 0 && (
                          <Badge mono icon={<Mail />}>{s.invitation_count}</Badge>
                        )}
                      </span>
                      {showFill && (
                        <Badge mono tone={isFull ? 'success' : 'warning'} icon={false}>
                          {s.confirmed_count}/{s.total_slots}
                        </Badge>
                      )}
                    </Row>
                  </td>
                  <td data-actions>
                    <ActionMenu actions={[
                      { label: t.view, onClick: () => navigate(`/sessions/${s.id}`) },
                      ...(s.status === 'draft' ? [{ label: t.delete, onClick: () => handleDelete(s.id), danger: true }] : []),
                    ]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <Dialog
        open={showModal}
        onOpenChange={setShowModal}
        title={t.newSessionTitle}
        footer={
          <>
            <Button onClick={() => setShowModal(false)}>{t.cancel}</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!selectedDate}>{t.create}</Button>
          </>
        }
      >
        <Stack gap={4}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t.date} htmlFor="new-session-date">
            <DateInput
              id="new-session-date"
              selected={selectedDate}
              onChange={setSelectedDate}
              filterDate={isClubDay}
              dateFormat={t.datePickerFormat}
              placeholderText={t.selectDate}
            />
          </Field>
          <Field label={t.timetable} htmlFor="new-session-timetable">
            <Select id="new-session-timetable" value={selectedTimetable} onChange={e => setSelectedTimetable(e.target.value)}>
              <option value="">{t.noTimetable}</option>
              {timetables.map(tt => (
                <option key={tt.id} value={tt.id}>{tt.name}{tt.is_default ? ` ${t.defaultSuffix}` : ''}</option>
              ))}
            </Select>
          </Field>
        </Stack>
      </Dialog>
    </Page>
  );
}
