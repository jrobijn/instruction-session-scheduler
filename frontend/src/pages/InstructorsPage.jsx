import { useState, useEffect } from 'react';
import { api } from '../api.js';

export default function InstructorsPage() {
  const [instructors, setInstructors] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', email: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setInstructors(await api.getInstructors());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', email: '' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (instructor) => {
    setEditing(instructor);
    setForm({ name: instructor.name, email: instructor.email });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        await api.updateInstructor(editing.id, form);
      } else {
        await api.createInstructor(form);
      }
      setShowModal(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this instructor?')) return;
    try {
      await api.deleteInstructor(id);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const toggleActive = async (instructor) => {
    try {
      await api.updateInstructor(instructor.id, { active: instructor.active ? 0 : 1 });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Instructors ({instructors.length})</h1>
        <button className="btn btn-primary" onClick={openCreate}>+ Add Instructor</button>
      </div>

      {instructors.length === 0 ? (
        <div className="empty-state">
          <h3>No instructors yet</h3>
          <p>Add your first instructor to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {instructors.map(i => (
              <tr key={i.id}>
                <td>{i.name}</td>
                <td>{i.email}</td>
                <td>
                  <span className={`badge ${i.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {i.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <div className="btn-group">
                    <button className="btn btn-outline btn-sm" onClick={() => openEdit(i)}>Edit</button>
                    <button className="btn btn-outline btn-sm" onClick={() => toggleActive(i)}>
                      {i.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(i.id)}>Delete</button>
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
            <h2>{editing ? 'Edit Instructor' : 'Add Instructor'}</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Name</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Add Instructor'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
