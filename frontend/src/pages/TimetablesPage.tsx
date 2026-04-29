import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import ActionDropdown from '../components/ActionDropdown';
import { useT } from '../i18n';

interface Timetable {
  id: number;
  name: string;
  status: string;
  is_default: number;
  active: number;
  timeslot_count: number;
}

export default function TimetablesPage() {
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const t = useT();

  const load = async () => {
    try {
      setTimetables(await api.getTimetables());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!name) return;
    setError('');
    try {
      const timetable = await api.createTimetable({ name });
      setShowModal(false);
      setName('');
      navigate(`/timetables/${timetable.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!confirm(t.confirmDeleteTimetable)) return;
    try {
      await api.deleteTimetable(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleToggleActive = async (id: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await api.toggleTimetableActive(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSetDefault = async (id: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await api.setDefaultTimetable(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>{t.loading}</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t.timetablesTitle(timetables.length)}</h1>
        <button className="btn btn-primary" onClick={() => { setError(''); setName(''); setShowModal(true); }}>{t.newTimetable}</button>
      </div>

      {timetables.length === 0 ? (
        <div className="empty-state">
          <h3>{t.noTimetablesYet}</h3>
          <p>{t.noTimetablesHint}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t.name}</th>
              <th>{t.status}</th>
              <th>{t.timeslots}</th>
              <th>{t.active}</th>
              <th>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {timetables.map(tt => (
              <tr key={tt.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/timetables/${tt.id}`)}>
                <td>
                  {tt.name}
                  {tt.is_default ? <span className="badge badge-confirmed" style={{ marginLeft: '0.5rem', fontSize: '0.7rem', padding: '0.1rem 0.4rem' }}>{t.default}</span> : null}
                </td>
                <td>
                  <span className={`badge ${tt.status === 'saved' ? 'badge-confirmed' : 'badge-draft'}`}>
                    {t.statusMap(tt.status)}
                  </span>
                </td>
                <td>{tt.timeslot_count}</td>
                <td>
                  <span className={`badge ${tt.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {tt.active ? t.active : t.inactive}
                  </span>
                </td>
                <td>
                  <ActionDropdown actions={[
                    { label: t.view, onClick: () => navigate(`/timetables/${tt.id}`) },
                    ...(tt.status === 'saved' && tt.active && !tt.is_default ? [{ label: t.setDefault, onClick: () => handleSetDefault(tt.id) }] : []),
                    { label: tt.active ? t.deactivate : t.activate, onClick: () => handleToggleActive(tt.id) },
                    { label: t.delete, onClick: () => handleDelete(tt.id), danger: true },
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
            <h2>{t.newTimetableTitle}</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label>{t.name}</label>
              <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t.timetableNamePlaceholder} required />
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setShowModal(false)}>{t.cancel}</button>
              <button className="btn btn-primary" onClick={handleCreate}>{t.create}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
