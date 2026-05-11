import { useState, useEffect, useRef, FormEvent } from 'react';
import { api } from '../api';
import ActionDropdown from '../components/ActionDropdown';
import { useT, getLocale } from '../i18n';

interface Student {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  membership_id: string;
  attended_sessions: number;
  no_show_count: number;
  priority: number;
  preferred_days: string;
  active: number;
  cooldown_until: string | null;
  groups?: Array<{ id: number; name: string; color: string | null }>;
}

interface Timetable {
  id: number;
  name: string;
  status: string;
  active: number;
  timeslots?: Array<{ id: number; start_time: string }>;
}


export default function StudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [clubDays, setClubDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Student | null>(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', membership_id: '', preferred_days: '0|1|2|3|4|5|6' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [timeslotPrefs, setTimeslotPrefs] = useState<Record<number, number[]>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sortCol, setSortCol] = useState<keyof Student>('last_name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [cooldownModal, setCooldownModal] = useState<Student | null>(null);
  const [cooldownDays, setCooldownDays] = useState(7);
  const [priorityMode, setPriorityMode] = useState(false);
  const [editedPriorities, setEditedPriorities] = useState<Record<number, number>>({});
  const [showPrioritySavePrompt, setShowPrioritySavePrompt] = useState(false);
  const [expandedStudent, setExpandedStudent] = useState<number | null>(null);
  const [detailTimetables, setDetailTimetables] = useState<Timetable[]>([]);
  const [detailTimeslotPrefs, setDetailTimeslotPrefs] = useState<Record<number, number[]>>({});
  const t = useT();

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
    setForm({ first_name: '', last_name: '', email: '', membership_id: '', preferred_days: '0|1|2|3|4|5|6' });
    setTimeslotPrefs({});
    setError('');
    await loadTimetables();
    setShowModal(true);
  };

  const openEdit = async (student: Student) => {
    setEditing(student);
    setForm({ first_name: student.first_name, last_name: student.last_name, email: student.email, membership_id: student.membership_id || '', preferred_days: student.preferred_days });
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
      // Save timeslot preferences for each timetable
      for (const tt of timetables) {
        const tsIds = timeslotPrefs[tt.id] ?? (tt.timeslots || []).map((s: any) => s.id);
        await api.setStudentPreferredTimeslots(studentId, tt.id, tsIds);
      }
      setShowModal(false);
      load();
      // Refresh detail prefs if the edited student is currently expanded
      if (expandedStudent === studentId) {
        try {
          const prefs = await api.getStudentPreferredTimeslots(studentId);
          setDetailTimeslotPrefs(prefs);
        } catch { setDetailTimeslotPrefs({}); }
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm(t.confirmDeleteStudent)) return;
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

  const hasActiveCooldown = (s: Student) => s.cooldown_until && new Date(s.cooldown_until + 'Z') > new Date();

  const getCooldownInfo = (s: Student) => {
    if (!hasActiveCooldown(s)) return null;
    const until = new Date(s.cooldown_until + 'Z');
    const days = Math.ceil((until.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
    return { days, date: until.toLocaleDateString(dateLocale) };
  };

  const handleSetCooldown = async () => {
    if (!cooldownModal) return;
    try {
      await api.setStudentCooldown(cooldownModal.id, cooldownDays);
      setCooldownModal(null);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleClearCooldown = async (id: number) => {
    try {
      await api.clearStudentCooldown(id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const getStudentPriority = (s: Student) =>
    priorityMode && s.id in editedPriorities ? editedPriorities[s.id] : s.priority;

  const togglePriorityMode = () => {
    if (priorityMode) {
      const changedCount = Object.entries(editedPriorities).filter(
        ([id, prio]) => students.find(s => s.id === Number(id))?.priority !== prio
      ).length;
      if (changedCount > 0) {
        setShowPrioritySavePrompt(true);
      } else {
        setPriorityMode(false);
        setEditedPriorities({});
      }
    } else {
      setPriorityMode(true);
      setEditedPriorities({});
    }
  };

  const savePriorities = async () => {
    const updates = Object.entries(editedPriorities)
      .filter(([id, prio]) => students.find(s => s.id === Number(id))?.priority !== prio)
      .map(([id, priority]) => ({ id: Number(id), priority }));
    try {
      await api.bulkUpdatePriorities(updates);
      await load();
    } catch (err: any) {
      alert(err.message);
    }
    setPriorityMode(false);
    setEditedPriorities({});
    setShowPrioritySavePrompt(false);
  };

  const discardPriorities = () => {
    setPriorityMode(false);
    setEditedPriorities({});
    setShowPrioritySavePrompt(false);
  };

  if (loading) return <div className="page"><p>{t.loading}</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t.studentsTitle(students.length)}</h1>
        <div className="btn-group">
          <button
            className={`btn ${priorityMode ? 'btn-primary' : 'btn-outline'}`}
            onClick={togglePriorityMode}
          >
            {priorityMode ? t.finishAdjusting : t.adjustPriorities}
          </button>
          <button className="btn btn-outline" onClick={handleExport} disabled={priorityMode}>{t.exportCsv}</button>
          <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()} disabled={priorityMode}>{t.importCsv}</button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImport} style={{ display: 'none' }} />
          <button className="btn btn-primary" onClick={openCreate} disabled={priorityMode}>{t.addStudent}</button>
        </div>
      </div>

      {priorityMode && (
        <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
          {t.priorityModeHint}
        </div>
      )}

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

      {students.length === 0 ? (
        <div className="empty-state">
          <h3>{t.noStudentsYet}</h3>
          <p>{t.noStudentsHint}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort('last_name')}>{t.name}{sortIcon('last_name')}</th>
              <th className="sortable" onClick={() => toggleSort('membership_id')}>{t.membershipId}{sortIcon('membership_id')}</th>
              <th className="sortable" onClick={() => toggleSort('attended_sessions')}>{t.sessionsAttended}{sortIcon('attended_sessions')}</th>
              <th className="sortable" onClick={() => toggleSort('no_show_count')}>{t.noShows}{sortIcon('no_show_count')}</th>
              <th className="sortable" onClick={() => toggleSort('priority')}>{t.priority}{sortIcon('priority')}</th>
              <th className="sortable" onClick={() => toggleSort('active')}>{t.status}{sortIcon('active')}</th>
              <th></th>
              <th>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sortedStudents.map(s => {
              const cooldownInfo = getCooldownInfo(s);
              const isExpanded = expandedStudent === s.id;
              return (
              <>
              <tr key={s.id} onClick={async () => {
                if (isExpanded) { setExpandedStudent(null); }
                else {
                  setExpandedStudent(s.id);
                  try {
                    const allTt = await api.getTimetables();
                    const active = allTt.filter((tt: Timetable) => tt.active && tt.status === 'saved');
                    const withTs = await Promise.all(active.map(async (tt: Timetable) => {
                      const detail = await api.getTimetable(tt.id);
                      return { ...tt, timeslots: detail.timeslots };
                    }));
                    setDetailTimetables(withTs);
                    const prefs = await api.getStudentPreferredTimeslots(s.id);
                    setDetailTimeslotPrefs(prefs);
                  } catch { setDetailTimetables([]); setDetailTimeslotPrefs({}); }
                }
              }} style={{ cursor: 'pointer' }}>
                <td>{s.first_name} {s.last_name}</td>
                <td>{s.membership_id}</td>
                <td>{s.attended_sessions}</td>
                <td>{s.no_show_count}</td>
                <td>
                  {priorityMode ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <button className="btn btn-outline btn-sm" onClick={(e) => { e.stopPropagation(); setEditedPriorities({ ...editedPriorities, [s.id]: Math.max(0, getStudentPriority(s) - 1) }); }}>−</button>
                      <span style={{ minWidth: '2ch', textAlign: 'center', fontWeight: getStudentPriority(s) !== s.priority ? 700 : 400, color: getStudentPriority(s) !== s.priority ? '#2563eb' : undefined }}>{getStudentPriority(s)}</span>
                      <button className="btn btn-outline btn-sm" onClick={(e) => { e.stopPropagation(); setEditedPriorities({ ...editedPriorities, [s.id]: getStudentPriority(s) + 1 }); }}>+</button>
                    </span>
                  ) : (
                    s.priority
                  )}
                </td>
                <td>
                  <span className={`badge ${s.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {s.active ? t.active : t.inactive}
                  </span>
                </td>
                <td>
                  {cooldownInfo ? (
                    <button
                      className="btn btn-sm"
                      style={{ background: '#dc2626', color: 'white', border: 'none', padding: '0.25rem 0.5rem', lineHeight: 1 }}
                      title={t.cooldownTooltip(cooldownInfo.days)}
                      onClick={(e) => { e.stopPropagation(); handleClearCooldown(s.id); }}
                    >⏱</button>
                  ) : (
                    <button
                      className="btn btn-outline btn-sm"
                      style={{ padding: '0.25rem 0.5rem', lineHeight: 1 }}
                      title={t.setCooldown}
                      onClick={(e) => { e.stopPropagation(); setCooldownModal(s); setCooldownDays(7); }}
                    >⏱</button>
                  )}
                </td>
                <td>
                  <ActionDropdown actions={[
                    { label: t.edit, onClick: () => openEdit(s) },
                    { label: s.active ? t.deactivate : t.activate, onClick: () => toggleActive(s) },
                    { label: t.delete, onClick: () => handleDelete(s.id), danger: true },
                  ]} />
                </td>
              </tr>
              {isExpanded && (
                <tr key={`${s.id}-details`}>
                  <td colSpan={8} style={{ background: 'var(--bg)', padding: '1rem 1.5rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem 2rem' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.5rem', alignItems: 'baseline' }}>
                        <strong>{t.firstName}:</strong> <span>{s.first_name}</span>
                        <strong>{t.lastName}:</strong> <span>{s.last_name}</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.5rem', alignItems: 'baseline' }}>
                        <strong>{t.email}:</strong> <span>{s.email}</span>
                        <strong>{t.membershipId}:</strong> <span>{s.membership_id || t.noData}</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.5rem', alignItems: 'baseline' }}>
                        <strong>{t.sessionsAttended}:</strong> <span>{s.attended_sessions}</span>
                        <strong>{t.noShows}:</strong> <span>{s.no_show_count}</span>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem 2rem', marginTop: '0.75rem' }}>
                      <div>
                        <div>
                          <strong>{t.preferredDays}:</strong>
                          <div style={{ marginTop: '0.25rem' }}>{s.preferred_days ? s.preferred_days.split('|').filter(d => clubDays.includes(Number(d))).map(d => t.days[Number(d)]).join(', ') || t.noData : t.noData}</div>
                        </div>
                        {detailTimetables.length > 0 && (
                          <div style={{ marginTop: '0.5rem' }}>
                            <strong>{t.preferredTimeslots}:</strong>
                            {detailTimetables.map(tt => {
                              const slots = tt.timeslots || [];
                              const prefIds = detailTimeslotPrefs[tt.id];
                              const display = prefIds && prefIds.length > 0
                                ? slots.filter(sl => prefIds.includes(sl.id)).map(sl => sl.start_time.slice(0, 5)).join(', ')
                                : null;
                              return (
                                <div key={tt.id} style={{ marginTop: '0.25rem' }}>
                                  <em>{tt.name}:</em> {display || t.noData}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <div>
                        <strong>{t.groups}:</strong>
                        {s.groups && s.groups.length > 0 ? s.groups.map(g => (
                          <div key={g.id} style={{ marginLeft: '0.25rem', marginTop: '0.25rem', display: 'flex', alignItems: 'center' }}>
                            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: g.color || '#999', marginRight: 8, flexShrink: 0 }} />{g.name}
                          </div>
                        )) : <span> {t.noData}</span>}
                      </div>
                      <div>
                        {cooldownInfo && (
                          <div style={{ color: 'var(--danger)' }}>
                            <strong>{t.cooldown}:</strong>
                            <div style={{ marginTop: '0.25rem' }}>{t.cooldownDetail(cooldownInfo.days, cooldownInfo.date)}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </>
              );
            })}
          </tbody>
        </table>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{editing ? t.editStudent : t.addStudentTitle}</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>{t.firstName}</label>
                <input autoFocus={!editing} value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>{t.lastName}</label>
                <input value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>{t.email}</label>
                <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>{t.membershipId}</label>
                <input value={form.membership_id} onChange={e => setForm({ ...form, membership_id: e.target.value })} />
              </div>
              <div className="form-group">
                <label>{t.preferredDays}</label>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {[0, 1, 2, 3, 4, 5, 6].map(idx => {
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
                        {t.days[idx]}
                      </label>
                    );
                  })}
                </div>
              </div>
              {timetables.length > 0 && (
                <div className="form-group">
                  <label>{t.preferredTimeslots}</label>
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
                            {t.all}
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
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>{t.cancel}</button>
                <button type="submit" className="btn btn-primary">{editing ? t.save : t.addStudentTitle}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {cooldownModal && (
        <div className="modal-overlay" onClick={() => setCooldownModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <h2>{t.setCooldownTitle}</h2>
            <p>{t.setCooldownText(`${cooldownModal.first_name} ${cooldownModal.last_name}`)}</p>
            <div className="form-group">
              <label>{t.cooldownDays}</label>
              <input type="number" min={1} value={cooldownDays} onChange={e => setCooldownDays(Number(e.target.value))} />
              {cooldownDays > 0 && (
                <small style={{ color: 'var(--text-muted)', marginTop: '0.25rem', display: 'block' }}>
                  {t.cooldownUntil(new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1000).toLocaleDateString(getLocale() === 'nl' ? 'nl-NL' : 'en-GB'))}
                </small>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setCooldownModal(null)}>{t.cancel}</button>
              <button className="btn btn-primary" onClick={handleSetCooldown} disabled={cooldownDays < 1}>{t.setCooldownButton}</button>
            </div>
          </div>
        </div>
      )}

      {showPrioritySavePrompt && (
        <div className="modal-overlay" onClick={discardPriorities}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <h2>{t.adjustPriorities}</h2>
            <p>{t.prioritySavePrompt(
              Object.entries(editedPriorities).filter(
                ([id, prio]) => students.find(s => s.id === Number(id))?.priority !== prio
              ).length
            )}</p>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={discardPriorities}>{t.discardChanges}</button>
              <button className="btn btn-primary" onClick={savePriorities}>{t.saveChanges}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
