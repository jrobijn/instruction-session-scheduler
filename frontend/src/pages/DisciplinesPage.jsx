import { useState, useEffect } from 'react';
import { api } from '../api.js';

export default function DisciplinesPage() {
  const [disciplines, setDisciplines] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setDisciplines(await api.getDisciplines());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (discipline) => {
    setEditing(discipline);
    setForm({ name: discipline.name });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        await api.updateDiscipline(editing.id, form);
      } else {
        await api.createDiscipline(form);
      }
      setShowModal(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this discipline?')) return;
    try {
      await api.deleteDiscipline(id);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const toggleActive = async (discipline) => {
    try {
      await api.updateDiscipline(discipline.id, { active: discipline.active ? 0 : 1 });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Disciplines ({disciplines.length})</h1>
        <button className="btn btn-primary" onClick={openCreate}>+ Add Discipline</button>
      </div>

      {disciplines.length === 0 ? (
        <div className="empty-state">
          <h3>No disciplines yet</h3>
          <p>Add your first discipline to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {disciplines.map(d => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>
                  <span className={`badge ${d.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {d.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <div className="btn-group">
                    <button className="btn btn-outline btn-sm" onClick={() => openEdit(d)}>Edit</button>
                    <button className="btn btn-outline btn-sm" onClick={() => toggleActive(d)}>
                      {d.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(d.id)}>Delete</button>
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
            <h2>{editing ? 'Edit Discipline' : 'Add Discipline'}</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Name</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Add Discipline'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
