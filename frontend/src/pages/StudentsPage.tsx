import { useState, useEffect, useRef, FormEvent } from 'react';
import { api } from '../api';

interface Student {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  attended_sessions: number;
  no_show_count: number;
  preferred_days: string;
  active: number;
}

interface Timetable {
  id: number;
  name: string;
  status: string;
  active: number;
  timeslots?: Array<{ id: number; start_time: string }>;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [clubDays, setClubDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Student | null>(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', preferred_days: '0|1|2|3|4|5|6' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [timeslotPrefs, setTimeslotPrefs] = useState<Record<number, number[]>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sortCol, setSortCol] = useState<keyof Student>('last_name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (col: keyof Student) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedStudents = [...students].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortIcon = (col: keyof Student) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const load = async () => {
    try {
      const [studentsData, settingsData] = await Promise.all([api.getStudents(), api.getSettings()]);
      setStudents(studentsData);
      const cd = (settingsData.club_days || '0|1|2|3|4|5|6').split('|').map(Number);
      setClubDays(cd);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const loadTimetables = async () => {
    try {
      const allTimetables = await api.getTimetables();
      const active = allTimetables.filter((t: Timetable) => t.active && t.status === 'saved');
      // Load timeslots for each active timetable
      const withTimeslots = await Promise.all(active.map(async (t: Timetable) => {
        const detail = await api.getTimetable(t.id);
        return { ...t, timeslots: detail.timeslots };
      }));
      setTimetables(withTimeslots);
    } catch { /* ignore */ }
  };

  const openCreate = async () => {
    setEditing(null);
    setForm({ first_name: '', last_name: '', email: '', preferred_days: '0|1|2|3|4|5|6' });
    setTimeslotPrefs({});
    setError('');
    await loadTimetables();
    setShowModal(true);
  };

  const openEdit = async (student: Student) => {
    setEditing(student);
    setForm({ first_name: student.first_name, last_name: student.last_name, email: student.email, preferred_days: student.preferred_days });
    setError('');
    await loadTimetables();
    try {
      const prefs = await api.getStudentPreferredTimeslots(student.id);
      setTimeslotPrefs(prefs);
    } catch {
      setTimeslotPrefs({});
    }
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      let studentId: number;
      if (editing) {
        await api.updateStudent(editing.id, form);
        studentId = editing.id;
      } else {
        const created = await api.createStudent(form);
        studentId = created.id;
      }
      // Save timeslot preferences for each timetable that has custom prefs
      for (const tt of timetables) {
        const tsIds = timeslotPrefs[tt.id];
        if (tsIds !== undefined) {
          await api.setStudentPreferredTimeslots(studentId, tt.id, tsIds);
        }
      }
      setShowModal(false);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this student?')) return;
    try {
      await api.deleteStudent(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const toggleActive = async (student: Student) => {
    try {
      await api.updateStudent(student.id, { active: student.active ? 0 : 1 });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleExport = async () => {
    try {
      const csv = await api.exportStudentsCsv();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'students.csv';
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
      const result = await api.importStudentsCsv(csv);
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
        <h1>Students ({students.length})</h1>
        <div className="btn-group">
          <button className="btn btn-outline" onClick={handleExport}>Export CSV</button>
          <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>Import CSV</button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImport} style={{ display: 'none' }} />
          <button className="btn btn-primary" onClick={openCreate}>+ Add Student</button>
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

      {students.length === 0 ? (
        <div className="empty-state">
          <h3>No students yet</h3>
          <p>Add your first student to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort('first_name')}>First Name{sortIcon('first_name')}</th>
              <th className="sortable" onClick={() => toggleSort('last_name')}>Last Name{sortIcon('last_name')}</th>
              <th className="sortable" onClick={() => toggleSort('email')}>Email{sortIcon('email')}</th>
              <th className="sortable" onClick={() => toggleSort('attended_sessions')}>Sessions Attended{sortIcon('attended_sessions')}</th>
              <th className="sortable" onClick={() => toggleSort('no_show_count')}>No-shows{sortIcon('no_show_count')}</th>
              <th className="sortable" onClick={() => toggleSort('active')}>Status{sortIcon('active')}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedStudents.map(s => (
              <tr key={s.id}>
                <td>{s.first_name}</td>
                <td>{s.last_name}</td>
                <td>{s.email}</td>
                <td>{s.attended_sessions}</td>
                <td>{s.no_show_count}</td>
                <td>
                  <span className={`badge ${s.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <div className="btn-group">
                    <button className="btn btn-outline btn-sm" onClick={() => openEdit(s)}>Edit</button>
                    <button className="btn btn-outline btn-sm" onClick={() => toggleActive(s)}>
                      {s.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(s.id)}>Delete</button>
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
            <h2>{editing ? 'Edit Student' : 'Add Student'}</h2>
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
              <div className="form-group">
                <label>Preferred Days</label>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {DAY_LABELS.map((label, idx) => {
                    const days = form.preferred_days ? form.preferred_days.split('|').filter(Boolean) : [];
                    const checked = days.includes(String(idx));
                    const isClubDay = clubDays.includes(idx);
                    return (
                      <label key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: isClubDay ? 'pointer' : 'not-allowed', opacity: isClubDay ? 1 : 0.4 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!isClubDay}
                          onChange={() => {
                            const newDays = checked
                              ? days.filter(d => d !== String(idx))
                              : [...days, String(idx)].sort();
                            setForm({ ...form, preferred_days: newDays.join('|') });
                          }}
                        />
                        {label}
                      </label>
                    );
                  })}
                </div>
              </div>
              {timetables.length > 0 && (
                <div className="form-group">
                  <label>Preferred Timeslots</label>
                  {timetables.map(tt => {
                    const slots = tt.timeslots || [];
                    const allSlotIds = slots.map(s => s.id);
                    // If no stored prefs for this timetable, all are selected (default)
                    const selectedIds = timeslotPrefs[tt.id] !== undefined
                      ? timeslotPrefs[tt.id]
                      : allSlotIds;
                    const allSelected = selectedIds.length === allSlotIds.length || timeslotPrefs[tt.id] === undefined;
                    return (
                      <div key={tt.id} style={{ marginBottom: '0.75rem' }}>
                        <div style={{ fontWeight: 500, fontSize: '0.85rem', marginBottom: '0.25rem' }}>{tt.name}</div>
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem', fontStyle: 'italic', marginRight: '0.25rem' }}>
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={() => {
                                if (allSelected) {
                                  // Uncheck all — set empty array
                                  setTimeslotPrefs({ ...timeslotPrefs, [tt.id]: [] });
                                } else {
                                  // Check all — remove entry (back to default)
                                  const next = { ...timeslotPrefs };
                                  delete next[tt.id];
                                  setTimeslotPrefs(next);
                                }
                              }}
                            />
                            All
                          </label>
                          {slots.map(slot => {
                            const checked = allSelected || selectedIds.includes(slot.id);
                            return (
                              <label key={slot.id} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    // When toggling individual, ensure we have an explicit list
                                    const current = allSelected ? [...allSlotIds] : [...selectedIds];
                                    const newIds = checked
                                      ? current.filter(id => id !== slot.id)
                                      : [...current, slot.id];
                                    // If all are now selected, remove entry (back to default)
                                    if (newIds.length >= allSlotIds.length) {
                                      const next = { ...timeslotPrefs };
                                      delete next[tt.id];
                                      setTimeslotPrefs(next);
                                    } else {
                                      setTimeslotPrefs({ ...timeslotPrefs, [tt.id]: newIds });
                                    }
                                  }}
                                />
                                {slot.start_time}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Add Student'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
