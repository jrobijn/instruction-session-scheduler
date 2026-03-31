import { useState, useEffect, useRef, FormEvent } from 'react';
import { api } from '../api';

interface Discipline {
  id: number;
  name: string;
  active: number;
}

export default function DisciplinesPage() {
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Discipline | null>(null);
  const [form, setForm] = useState({ name: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sortCol, setSortCol] = useState<keyof Discipline>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (col: keyof Discipline) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedDisciplines = [...disciplines].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortIcon = (col: keyof Discipline) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const load = async () => {
    try {
      setDisciplines(await api.getDisciplines());
    } catch (err: any) {
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

  const openEdit = (discipline: Discipline) => {
    setEditing(discipline);
    setForm({ name: discipline.name });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
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
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this discipline?')) return;
    try {
      await api.deleteDiscipline(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const toggleActive = async (discipline: Discipline) => {
    try {
      await api.updateDiscipline(discipline.id, { active: discipline.active ? 0 : 1 });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleExport = async () => {
    try {
      const csv = await api.exportDisciplinesCsv();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'disciplines.csv';
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
      const result = await api.importDisciplinesCsv(csv);
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
        <h1>Disciplines ({disciplines.length})</h1>
        <div className="btn-group">
          <button className="btn btn-outline" onClick={handleExport}>Export CSV</button>
          <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>Import CSV</button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImport} style={{ display: 'none' }} />
          <button className="btn btn-primary" onClick={openCreate}>+ Add Discipline</button>
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

      {disciplines.length === 0 ? (
        <div className="empty-state">
          <h3>No disciplines yet</h3>
          <p>Add your first discipline to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort('name')}>Name{sortIcon('name')}</th>
              <th className="sortable" onClick={() => toggleSort('active')}>Status{sortIcon('active')}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedDisciplines.map(d => (
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
