import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ActionDropdown from '../components/ActionDropdown';
import DatePicker from 'react-datepicker';
import { api } from '../api';

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
    if (!confirm('Are you sure you want to delete this session?')) return;
    try {
      await api.deleteSession(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Training Sessions ({sessions.length})</h1>
        <button className="btn btn-primary" onClick={openCreateModal}>+ New Session</button>
      </div>

      {sessions.length === 0 ? (
        <div className="empty-state">
          <h3>No training sessions yet</h3>
          <p>Create your first training session to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Timetable</th>
              <th>Instructors</th>
              <th>Invitations</th>
              <th>Actions</th>
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
                    {s.status.replace(/_/g, ' ')}
                  </span>
                </td>
                <td>{s.timetable_name || '—'}</td>
                <td>{s.instructor_count}</td>
                <td>{s.invitation_count}</td>
                <td>
                  <ActionDropdown actions={[
                    { label: 'View', onClick: () => navigate(`/sessions/${s.id}`) },
                    ...(s.status === 'draft' ? [{ label: 'Delete', onClick: () => handleDelete(s.id), danger: true }] : []),
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
            <h2>New Training Session</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label>Date</label>
              <DatePicker
                selected={selectedDate}
                onChange={(d: Date | null) => setSelectedDate(d)}
                filterDate={isClubDay}
                dateFormat="yyyy-MM-dd"
                placeholderText="Select a date..."
                className="datepicker-input"
              />
            </div>
            <div className="form-group">
              <label>Timetable</label>
              <select value={selectedTimetable} onChange={e => setSelectedTimetable(e.target.value)}>
                <option value="">No timetable</option>
                {timetables.map(t => (
                  <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={!selectedDate}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
