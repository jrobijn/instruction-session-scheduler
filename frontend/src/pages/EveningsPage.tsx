import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

interface Evening {
  id: number;
  date: string;
  status: string;
  instructor_count: number;
  invitation_count: number;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export default function EveningsPage() {
  const [evenings, setEvenings] = useState<Evening[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [date, setDate] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = async () => {
    try {
      setEvenings(await api.getEvenings());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!date) return;
    setError('');
    try {
      const evening = await api.createEvening({ date });
      setShowModal(false);
      setDate('');
      navigate(`/evenings/${evening.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this evening?')) return;
    try {
      await api.deleteEvening(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Training Evenings ({evenings.length})</h1>
        <button className="btn btn-primary" onClick={() => { setError(''); setShowModal(true); }}>+ New Evening</button>
      </div>

      {evenings.length === 0 ? (
        <div className="empty-state">
          <h3>No training evenings yet</h3>
          <p>Create your first training evening to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Instructors</th>
              <th>Invitations</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {evenings.map(e => (
              <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/evenings/${e.id}`)}>
                <td>{formatDate(e.date)}</td>
                <td>
                  <span className={`badge ${
                    e.status === 'completed' ? 'badge-confirmed' :
                    e.status === 'invitations_sent' ? 'badge-pending' :
                    e.status === 'scheduled' ? 'badge-pending' :
                    'badge-declined'
                  }`}>
                    {e.status.replace(/_/g, ' ')}
                  </span>
                </td>
                <td>{e.instructor_count}</td>
                <td>{e.invitation_count}</td>
                <td>
                  <div className="btn-group">
                    <button className="btn btn-outline btn-sm" onClick={(ev) => { ev.stopPropagation(); navigate(`/evenings/${e.id}`); }}>View</button>
                    {e.status === 'draft' && (
                      <button className="btn btn-danger btn-sm" onClick={(ev) => { ev.stopPropagation(); handleDelete(e.id); }}>Delete</button>
                    )}
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
            <h2>New Training Evening</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label>Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} required />
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
