import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

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

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this timetable? Sessions using it may be affected.')) return;
    try {
      await api.deleteTimetable(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleToggleActive = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.toggleTimetableActive(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSetDefault = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.setDefaultTimetable(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Timetables ({timetables.length})</h1>
        <button className="btn btn-primary" onClick={() => { setError(''); setName(''); setShowModal(true); }}>+ New Timetable</button>
      </div>

      {timetables.length === 0 ? (
        <div className="empty-state">
          <h3>No timetables yet</h3>
          <p>Create your first timetable to define reusable timeslot configurations.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Timeslots</th>
              <th>Active</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {timetables.map(t => (
              <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/timetables/${t.id}`)}>
                <td>
                  {t.name}
                  {t.is_default ? <span className="badge badge-confirmed" style={{ marginLeft: '0.5rem', fontSize: '0.7rem', padding: '0.1rem 0.4rem' }}>default</span> : null}
                </td>
                <td>
                  <span className={`badge ${t.status === 'saved' ? 'badge-confirmed' : 'badge-draft'}`}>
                    {t.status}
                  </span>
                </td>
                <td>{t.timeslot_count}</td>
                <td>
                  <span className={`badge ${t.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {t.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <div className="btn-group">
                    <button className="btn btn-outline btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/timetables/${t.id}`); }}>View</button>
                    {t.status === 'saved' && t.active && !t.is_default && (
                      <button className="btn btn-outline btn-sm" onClick={(e) => handleSetDefault(t.id, e)}>Set Default</button>
                    )}
                    <button className="btn btn-outline btn-sm" onClick={(e) => handleToggleActive(t.id, e)}>
                      {t.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={(e) => handleDelete(t.id, e)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>New Timetable</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label>Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Wednesday Evening" required />
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
