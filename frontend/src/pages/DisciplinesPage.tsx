import { useState, useEffect, useRef, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import ActionDropdown from '../components/ActionDropdown';
import { useT } from '../i18n';

interface Discipline {
  id: number;
  name: string;
  active: number;
  groups: Array<{ id: number; name: string }>;
}

interface Group {
  id: number;
  name: string;
  active: number;
  is_default: number;
}

export default function DisciplinesPage() {
  const navigate = useNavigate();
  const t = useT();
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Discipline | null>(null);
  const [form, setForm] = useState({ name: '' });
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sortCol, setSortCol] = useState<keyof Discipline>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (col: keyof Discipline) => {
    if (col === 'groups') return;
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
      const [discs, groups] = await Promise.all([api.getDisciplines(), api.getGroups()]);
      setDisciplines(discs);
      setAllGroups(groups.filter((g: Group) => g.active));
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
    setSelectedGroupIds([]);
    setError('');
    setShowModal(true);
  };

  const openEdit = (discipline: Discipline) => {
    setEditing(discipline);
    setForm({ name: discipline.name });
    setSelectedGroupIds(discipline.groups.map(g => g.id));
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      let discId: number;
      if (editing) {
        await api.updateDiscipline(editing.id, form);
        discId = editing.id;
      } else {
        const created = await api.createDiscipline(form);
        discId = created.id;
      }
      await api.setDisciplineGroups(discId, selectedGroupIds);
      setShowModal(false);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm(t.confirmDeleteDiscipline)) return;
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

  if (loading) return <div className="page"><p>{t.loading}</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t.disciplinesTitle(disciplines.length)}</h1>
        <div className="btn-group">
          <button className="btn btn-outline" onClick={handleExport}>{t.exportCsv}</button>
          <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>{t.importCsv}</button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImport} style={{ display: 'none' }} />
          <button className="btn btn-primary" onClick={openCreate}>{t.addDiscipline}</button>
        </div>
      </div>

      {importResult && (
        <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
          {t.importResult(importResult.imported, importResult.skipped)}
          {importResult.errors.length > 0 && (
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.5rem' }}>
              {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          <button className="btn btn-outline btn-sm" style={{ marginLeft: '1rem' }} onClick={() => setImportResult(null)}>{t.dismiss}</button>
        </div>
      )}

      {disciplines.length === 0 ? (
        <div className="empty-state">
          <h3>{t.noDisciplinesYet}</h3>
          <p>{t.noDisciplinesHint}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort('name')}>{t.name}{sortIcon('name')}</th>
              <th>{t.groups}</th>
              <th className="sortable" onClick={() => toggleSort('active')}>{t.status}{sortIcon('active')}</th>
              <th>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sortedDisciplines.map(d => (
              <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/disciplines/${d.id}`)}>
                <td>{d.name}</td>
                <td>{d.groups.length}</td>
                <td>
                  <span className={`badge ${d.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {d.active ? t.active : t.inactive}
                  </span>
                </td>
                <td>
                  <ActionDropdown actions={[
                    { label: t.edit, onClick: () => openEdit(d) },
                    { label: d.active ? t.deactivate : t.activate, onClick: () => toggleActive(d) },
                    { label: t.delete, onClick: () => handleDelete(d.id), danger: true },
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
            <h2>{editing ? t.editDiscipline : t.addDisciplineTitle}</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>{t.name}</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>{t.groupsWithAccess}</label>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {allGroups.map(g => {
                    const checked = selectedGroupIds.includes(g.id);
                    return (
                      <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSelectedGroupIds(checked
                              ? selectedGroupIds.filter(id => id !== g.id)
                              : [...selectedGroupIds, g.id]
                            );
                          }}
                        />
                        {g.name}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>{t.cancel}</button>
                <button type="submit" className="btn btn-primary">{editing ? t.save : t.addDisciplineTitle}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
