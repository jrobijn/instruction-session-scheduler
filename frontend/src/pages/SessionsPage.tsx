import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ActionDropdown from '../components/ActionDropdown';
import DatePicker from 'react-datepicker';
import { api } from '../api';
import { useT } from '../i18n';

interface Session {
  id: number;
  date: string;
  status: string;
  timetable_id: number | null;
  timetable_name: string | null;
  instructor_count: number;
  invitation_count: number;
}

interface Timetable {
  id: number;
  name: string;
  is_default: number;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
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
    if (!confirm(t.confirmDeleteSession)) return;
    try {
      await api.deleteSession(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>{t.loading}</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t.sessionsTitle(sessions.length)}</h1>
        <button className="btn btn-primary" onClick={openCreateModal}>{t.newSession}</button>
      </div>

      {sessions.length === 0 ? (
        <div className="empty-state">
          <h3>{t.noSessionsYet}</h3>
          <p>{t.noSessionsHint}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t.date}</th>
              <th>{t.status}</th>
              <th>{t.timetable}</th>
              <th>{t.instructors}</th>
              <th>{t.invitations}</th>
              <th>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/sessions/${s.id}`)}>
                <td>{formatDate(s.date)}</td>
                <td>
                  <span className={`badge ${
                    s.status === 'completed' ? 'badge-confirmed' :
                    s.status === 'invitations_sent' ? 'badge-pending' :
                    s.status === 'scheduled' ? 'badge-pending' :
                    s.status === 'draft' ? 'badge-draft' :
                    'badge-declined'
                  }`}>
                    {t.statusMap(s.status)}
                  </span>
                </td>
                <td>{s.timetable_name || t.noData}</td>
                <td>{s.instructor_count}</td>
                <td>{s.invitation_count}</td>
                <td>
                  <ActionDropdown actions={[
                    { label: t.view, onClick: () => navigate(`/sessions/${s.id}`) },
                    ...(s.status === 'draft' ? [{ label: t.delete, onClick: () => handleDelete(s.id), danger: true }] : []),
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{t.newSessionTitle}</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label>{t.date}</label>
              <DatePicker
                selected={selectedDate}
                onChange={(d: Date | null) => setSelectedDate(d)}
                filterDate={isClubDay}
                dateFormat="yyyy-MM-dd"
                placeholderText={t.selectDate}
                className="datepicker-input"
              />
            </div>
            <div className="form-group">
              <label>{t.timetable}</label>
              <select value={selectedTimetable} onChange={e => setSelectedTimetable(e.target.value)}>
                <option value="">{t.noTimetable}</option>
                {timetables.map(tt => (
                  <option key={tt.id} value={tt.id}>{tt.name}{tt.is_default ? ` ${t.defaultSuffix}` : ''}</option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setShowModal(false)}>{t.cancel}</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={!selectedDate}>{t.create}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
