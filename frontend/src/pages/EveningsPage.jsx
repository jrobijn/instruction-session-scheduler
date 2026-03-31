import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function EveningsPage() {
  const [evenings, setEvenings] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ date: '', notes: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = async () => {
    try {
      setEvenings(await api.getEvenings());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.createEvening(form);
      setShowModal(false);
      setForm({ date: '', notes: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this training evening and all its invitations?')) return;
    try {
      await api.deleteEvening(id);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Training Evenings</h1>
        <button className="btn btn-primary" onClick={() => { setError(''); setShowModal(true); }}>+ New Evening</button>
      </div>

      {evenings.length === 0 ? (
        <div className="empty-state">
          <h3>No training evenings scheduled</h3>
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
            {evenings.map(ev => (
              <tr key={ev.id}>
                <td style={{ fontWeight: 600 }}>{formatDate(ev.date)}</td>
                <td><span className={`badge badge-${ev.status}`}>{ev.status}</span></td>
                <td>{ev.instructor_count}</td>
                <td>{ev.invitation_count}</td>
                <td>
                  <div className="btn-group">
                    <button className="btn btn-primary btn-sm" onClick={() => navigate(`/evenings/${ev.id}`)}>
                      Manage
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(ev.id)}>Delete</button>
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
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Notes (optional)</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={3} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
}
