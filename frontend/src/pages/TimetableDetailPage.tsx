import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';

interface Timeslot {
  id: number;
  timetable_id: number;
  start_time: string;
}

interface TimetableDetail {
  id: number;
  name: string;
  status: string;
  is_default: number;
  active: number;
  timeslots: Timeslot[];
}

export default function TimetableDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [timetable, setTimetable] = useState<TimetableDetail | null>(null);
  const [editName, setEditName] = useState('');
  const [newTimeslotTime, setNewTimeslotTime] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await api.getTimetable(Number(id));
      setTimetable(data);
      setEditName(data.name);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const updateName = async () => {
    if (!editName || editName === timetable?.name) return;
    try {
      await api.updateTimetable(Number(id), { name: editName });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const addTimeslot = async () => {
    if (!newTimeslotTime) return;
    try {
      await api.addTimetableTimeslot(Number(id), newTimeslotTime);
      setNewTimeslotTime('');
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const deleteTimeslot = async (timeslotId: number) => {
    try {
      await api.deleteTimetableTimeslot(Number(id), timeslotId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSave = async () => {
    if (!confirm('Save this timetable? It will become read-only after saving.')) return;
    try {
      await api.saveTimetable(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSetDefault = async () => {
    try {
      await api.setDefaultTimetable(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleToggleActive = async () => {
    try {
      await api.toggleTimetableActive(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this timetable? Sessions using it may be affected.')) return;
    try {
      await api.deleteTimetable(Number(id));
      navigate('/timetables');
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;
  if (!timetable) return <div className="page"><p>Timetable not found</p></div>;

  const isDraft = timetable.status === 'draft';

  return (
    <div className="page">
      <button className="btn btn-outline" onClick={() => navigate('/timetables')} style={{ marginBottom: '1rem' }}>
        ← Back to Timetables
      </button>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="page-header">
        <h1>{timetable.name}</h1>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className={`badge ${timetable.status === 'saved' ? 'badge-confirmed' : 'badge-draft'}`}>
            {timetable.status}
          </span>
          <span className={`badge ${timetable.active ? 'badge-confirmed' : 'badge-declined'}`}>
            {timetable.active ? 'Active' : 'Inactive'}
          </span>
          {timetable.is_default ? <span className="badge badge-confirmed">default</span> : null}
        </div>
      </div>

      {/* Name editing (draft only) */}
      {isDraft && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>Name</h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input value={editName} onChange={e => setEditName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-outline" onClick={updateName} disabled={editName === timetable.name || !editName}>Update Name</button>
          </div>
        </div>
      )}

      {/* Timeslots Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>Timeslots ({timetable.timeslots.length})</h2>
        {isDraft && (
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <input type="time" value={newTimeslotTime} onChange={e => setNewTimeslotTime(e.target.value)} />
            <button className="btn btn-primary" onClick={addTimeslot} disabled={!newTimeslotTime}>Add Timeslot</button>
          </div>
        )}
        {timetable.timeslots.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No timeslots defined yet.</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {timetable.timeslots.map(ts => (
              <span key={ts.id} className="badge badge-pending" style={{ fontSize: '0.95rem', padding: '0.4rem 0.8rem' }}>
                {ts.start_time}
                {isDraft && (
                  <button onClick={() => deleteTimeslot(ts.id)} style={{ marginLeft: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>Actions</h2>
        <div className="btn-group">
          {isDraft && timetable.timeslots.length > 0 && (
            <button className="btn btn-primary" onClick={handleSave}>Save Timetable</button>
          )}
          {timetable.status === 'saved' && timetable.active && !timetable.is_default && (
            <button className="btn btn-outline" onClick={handleSetDefault}>Set as Default</button>
          )}
          <button className="btn btn-outline" onClick={handleToggleActive}>
            {timetable.active ? 'Deactivate' : 'Activate'}
          </button>
          <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
        </div>
        {isDraft && (
          <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '0.5rem' }}>
            Saving will finalize this timetable and make it read-only. Only saved timetables can be attached to sessions.
          </p>
        )}
      </div>
    </div>
  );
}
