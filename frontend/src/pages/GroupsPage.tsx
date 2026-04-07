import { useState, useEffect, useRef, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

interface Group {
  id: number;
  name: string;
  priority: number;
  color: string;
  is_default: number;
  active: number;
  member_count: number;
}

export default function GroupsPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<Group[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [form, setForm] = useState({ name: '', priority: '9999', color: '#3b82f6' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sortCol, setSortCol] = useState<keyof Group>('priority');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (col: keyof Group) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedGroups = [...groups].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortIcon = (col: keyof Group) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const load = async () => {
    try {
      setGroups(await api.getGroups());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', priority: '9999', color: '#3b82f6' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (group: Group) => {
    setEditing(group);
    setForm({ name: group.name, priority: String(group.priority), color: group.color || '#3b82f6' });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        await api.updateGroup(editing.id, { name: form.name, priority: Number(form.priority), color: form.color });
      } else {
        await api.createGroup({ name: form.name, priority: Number(form.priority), color: form.color });
      }
      setShowModal(false);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (group: Group) => {
    if (!confirm(`Are you sure you want to delete the group "${group.name}"?`)) return;
    try {
      await api.deleteGroup(group.id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const toggleActive = async (group: Group) => {
    try {
      await api.updateGroup(group.id, { active: group.active ? 0 : 1 });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleExport = async () => {
    try {
      const csv = await api.exportGroupsCsv();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'groups.csv';
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
      const result = await api.importGroupsCsv(csv);
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
        <h1>Groups ({groups.length})</h1>
        <div className="btn-group">
          <button className="btn btn-outline" onClick={handleExport}>Export CSV</button>
          <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>Import CSV</button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImport} style={{ display: 'none' }} />
          <button className="btn btn-primary" onClick={openCreate}>+ Add Group</button>
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

      {groups.length === 0 ? (
        <div className="empty-state">
          <h3>No groups yet</h3>
          <p>Add your first group to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort('name')}>Name{sortIcon('name')}</th>
              <th>Color</th>
              <th className="sortable" onClick={() => toggleSort('priority')}>Priority{sortIcon('priority')}</th>
              <th className="sortable" onClick={() => toggleSort('member_count')}>Members{sortIcon('member_count')}</th>
              <th className="sortable" onClick={() => toggleSort('active')}>Status{sortIcon('active')}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedGroups.map(g => (
              <tr key={g.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/groups/${g.id}`)}>
                <td>{g.name}{g.is_default ? ' (default)' : ''}</td>
                <td>
                  <input
                    type="color"
                    value={g.color || '#3b82f6'}
                    onClick={e => e.stopPropagation()}
                    onChange={async e => {
                      e.stopPropagation();
                      try {
                        await api.updateGroup(g.id, { color: e.target.value });
                        load();
                      } catch { /* ignore */ }
                    }}
                    style={{ width: '32px', height: '24px', padding: 0, border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }}
                  />
                </td>
                <td>{g.priority}</td>
                <td>{g.member_count}</td>
                <td>
                  <span className={`badge ${g.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {g.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <div className="btn-group">
                    {!g.is_default && (
                      <>
                        <button className="btn btn-outline btn-sm" onClick={e => { e.stopPropagation(); openEdit(g); }}>Edit</button>
                        <button className="btn btn-outline btn-sm" onClick={e => { e.stopPropagation(); toggleActive(g); }}>
                          {g.active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={e => { e.stopPropagation(); handleDelete(g); }}>Delete</button>
                      </>
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
            <h2>{editing ? 'Edit Group' : 'Add Group'}</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Name</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Priority (lower = higher priority, max 9999)</label>
                <input type="number" min="1" max="9999" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Color</label>
                <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} style={{ width: '60px', height: '32px', padding: 0, border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Add Group'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
