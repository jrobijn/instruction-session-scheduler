import { useState, useEffect, useRef, FormEvent } from 'react';
import { api } from '../api';

interface Instructor {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  active: number;
}

export default function InstructorsPage() {
  const [instructors, setInstructors] = useState<Instructor[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Instructor | null>(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setInstructors(await api.getInstructors());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ first_name: '', last_name: '', email: '' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (instructor: Instructor) => {
    setEditing(instructor);
    setForm({ first_name: instructor.first_name, last_name: instructor.last_name, email: instructor.email });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
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
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this instructor?')) return;
    try {
      await api.deleteInstructor(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const toggleActive = async (instructor: Instructor) => {
    try {
      await api.updateInstructor(instructor.id, { active: instructor.active ? 0 : 1 });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleExport = async () => {
    try {
      const csv = await api.exportInstructorsCsv();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'instructors.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const csv = await file.text();
      const result = await api.importInstructorsCsv(csv);
      setImportResult(result);
      load();
    } catch (err: any) {
      alert(err.message);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Instructors ({instructors.length})</h1>
        <div className="btn-group">
          <button className="btn btn-outline" onClick={handleExport}>Export CSV</button>
          <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>Import CSV</button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImport} style={{ display: 'none' }} />
          <button className="btn btn-primary" onClick={openCreate}>+ Add Instructor</button>
        </div>
      </div>

      {importResult && (
        <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
          Imported: {importResult.imported}, Skipped: {importResult.skipped}
          {importResult.errors.length > 0 && (
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.5rem' }}>
              {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          <button className="btn btn-outline btn-sm" style={{ marginLeft: '1rem' }} onClick={() => setImportResult(null)}>Dismiss</button>
        </div>
      )}

      {instructors.length === 0 ? (
        <div className="empty-state">
          <h3>No instructors yet</h3>
          <p>Add your first instructor to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>First Name</th>
              <th>Last Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {instructors.map(i => (
              <tr key={i.id}>
                <td>{i.first_name}</td>
                <td>{i.last_name}</td>
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
                <label>First Name</label>
                <input value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Last Name</label>
                <input value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })} required />
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
