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
  preferred_days: string;
  active: number;
  cooldown_until: string | null;
  group?: { id: number; name: string; color: string | null } | null;
  buddy_group?: { id: number; name: string } | null;
}

interface Timetable {
  id: number;
  name: string;
  status: string;
  active: number;
  timeslots?: Array<{ id: number; start_time: string }>;
}

interface InvitationHistoryEntry {
  id: number;
  status: string;
  invited_at: string;
  responded_at: string | null;
  session_date: string;
  start_time: string;
  discipline_name: string | null;
  group_name: string | null;
  group_color: string | null;
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
  const [expandedStudent, setExpandedStudent] = useState<number | null>(null);
  const [detailTimetables, setDetailTimetables] = useState<Timetable[]>([]);
  const [detailTimeslotPrefs, setDetailTimeslotPrefs] = useState<Record<number, number[]>>({});
  const [historyModal, setHistoryModal] = useState<Student | null>(null);
  const [historyEntries, setHistoryEntries] = useState<InvitationHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [buddyMode, setBuddyMode] = useState(false);
  const [buddySelection, setBuddySelection] = useState<Set<number>>(new Set());
  const [groupBuddies, setGroupBuddies] = useState(() => localStorage.getItem('groupBuddies') !== 'false');
  const t = useT();

  const toggleGroupBuddies = () => {
    setGroupBuddies(prev => {
      const next = !prev;
      localStorage.setItem('groupBuddies', String(next));
      return next;
    });
  };

  const toggleSort = (col: keyof Student) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedStudents = (() => {
    const base = [...students].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    // Group buddy members together: place them after the first buddy in sort order
    if (!groupBuddies) return base;
    const placed = new Set<number>();
    const result: Student[] = [];
    for (const s of base) {
      if (placed.has(s.id)) continue;
      result.push(s);
      placed.add(s.id);
      if (s.buddy_group) {
        const buddies = base.filter(b => b.id !== s.id && !placed.has(b.id) && b.buddy_group?.id === s.buddy_group!.id);
        for (const b of buddies) {
          result.push(b);
          placed.add(b.id);
        }
      }
    }
    return result;
  })();

  // Assign distinct colors to buddy groups
  const BUDDY_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#c026d3', '#ea580c', '#4f46e5', '#059669'];
  const buddyColorMap = new Map<number, string>();
  const seenBuddyIds = [...new Set(sortedStudents.map(s => s.buddy_group?.id).filter(Boolean))] as number[];
  seenBuddyIds.forEach((bgId, i) => buddyColorMap.set(bgId, BUDDY_COLORS[i % BUDDY_COLORS.length]));

  const sortIcon = (col: keyof Student) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const invitationBadgeClass = (status: string) =>
    status === 'confirmed' ? 'badge-confirmed' :
    status === 'declined' || status === 'cancelled' || status === 'admin_cancelled' || status === 'expired' ? 'badge-declined' :
    status === 'scheduled' ? 'badge-draft' :
    'badge-pending';

  const formatInvitedAt = (value: string) => {
    const d = new Date(value.includes('Z') || value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
    const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
    return d.toLocaleString(dateLocale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const openHistory = async (student: Student) => {
    setHistoryModal(student);
    setHistoryEntries([]);
    setHistoryLoading(true);
    try {
      const history = await api.getStudentInvitationHistory(student.id);
      setHistoryEntries(history);
    } catch {
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  };

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

  const toggleBuddyMode = () => {
    setBuddyMode(!buddyMode);
    setBuddySelection(new Set());
  };

  const toggleBuddySelect = (id: number) => {
    setBuddySelection(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGroupSelected = async () => {
    const ids = Array.from(buddySelection);
    if (ids.length < 2) return;
    try {
      await api.quickCreateBuddyGroup(ids);
      setBuddySelection(new Set());
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUngroupBuddy = async (groupId: number) => {
    if (!confirm(t.confirmDissolveBuddyGroup)) return;
    try {
      await api.deleteBuddyGroup(groupId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRemoveFromBuddy = async (student: Student) => {
    if (!student.buddy_group) return;
    try {
      await api.removeBuddyGroupMember(student.buddy_group.id, student.id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>{t.loading}</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t.studentsTitle(students.length)}</h1>
        <div className="btn-group">
          <div style={{ display: 'flex' }}>
            <button
              className={`btn ${buddyMode ? 'btn-primary' : 'btn-outline'}`}
              onClick={toggleBuddyMode}
              style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
            >
              {buddyMode ? t.finishBuddyMode : t.manageBuddies}
            </button>
            <button
              className="btn btn-outline"
              onClick={toggleGroupBuddies}
              title={groupBuddies ? t.groupBuddiesOn : t.groupBuddiesOff}
              style={{
                padding: '0.4rem 0.5rem', lineHeight: 1, marginLeft: '-1px',
                borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                ...(groupBuddies ? { background: 'var(--hover-row)', color: 'var(--text)' } : {}),
              }}
            >
              <svg style={{ width: '16px', height: '16px', verticalAlign: 'middle' }} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
              </svg>
            </button>
          </div>
          <button className="btn btn-outline" onClick={handleExport} disabled={buddyMode}>{t.exportCsv}</button>
          <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()} disabled={buddyMode}>{t.importCsv}</button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImport} style={{ display: 'none' }} />
          <button className="btn btn-primary" onClick={openCreate} disabled={buddyMode}>{t.addStudent}</button>
        </div>
      </div>

      {buddyMode && (
        <div className="alert alert-info" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span>{t.buddyModeHint}</span>
          {buddySelection.size >= 2 && (
            <button className="btn btn-primary btn-sm" onClick={handleGroupSelected}>
              {t.groupSelected(buddySelection.size)}
            </button>
          )}
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
              {buddyMode && <th style={{ width: '2rem' }}></th>}
              <th className="sortable" onClick={() => toggleSort('last_name')}>{t.name}{sortIcon('last_name')}</th>
              <th className="sortable" onClick={() => toggleSort('membership_id')}>{t.membershipId}{sortIcon('membership_id')}</th>
              <th className="sortable" onClick={() => toggleSort('attended_sessions')}>{t.sessionsAttended}{sortIcon('attended_sessions')}</th>
              <th className="sortable" onClick={() => toggleSort('no_show_count')}>{t.noShows}{sortIcon('no_show_count')}</th>
              <th className="sortable" onClick={() => toggleSort('active')}>{t.status}{sortIcon('active')}</th>
              <th></th>
              <th></th>
              <th>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sortedStudents.map((s, idx) => {
              const cooldownInfo = getCooldownInfo(s);
              const isExpanded = expandedStudent === s.id;
              // Buddy group visual grouping
              const hasBuddy = !!s.buddy_group;
              const buddyColor = hasBuddy ? buddyColorMap.get(s.buddy_group!.id) || '#3b82f6' : '';
              const isFirstInBuddy = hasBuddy && (idx === 0 || sortedStudents[idx - 1].buddy_group?.id !== s.buddy_group!.id);
              const isLastInBuddy = hasBuddy && (idx === sortedStudents.length - 1 || sortedStudents[idx + 1].buddy_group?.id !== s.buddy_group!.id);
              const buddyRowStyle = hasBuddy ? {
                borderLeft: `3px solid ${buddyColor}`,
                background: `${buddyColor}08`,
                ...(isFirstInBuddy ? { borderTop: `1px solid ${buddyColor}` } : {}),
                ...(isLastInBuddy ? { borderBottom: `1px solid ${buddyColor}` } : {}),
              } : {};
              return (
              <>
              <tr key={s.id} onClick={async () => {
                if (buddyMode) {
                  if (!s.buddy_group) toggleBuddySelect(s.id);
                  return;
                }
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
              }} style={{ cursor: 'pointer', ...buddyRowStyle }}>
                {buddyMode && (
                  <td onClick={e => e.stopPropagation()}>
                    {!s.buddy_group && (
                      <input
                        type="checkbox"
                        checked={buddySelection.has(s.id)}
                        onChange={() => toggleBuddySelect(s.id)}
                        style={{ cursor: 'pointer' }}
                      />
                    )}
                  </td>
                )}
                <td>
                  {s.first_name} {s.last_name}
                  {s.buddy_group && (
                    <>
                      <svg style={{ width: '14px', height: '14px', flexShrink: 0, marginLeft: '0.4rem', verticalAlign: 'middle' }} viewBox="0 0 24 24" fill={buddyColor} xmlns="http://www.w3.org/2000/svg">
                        <title>{s.buddy_group.name}</title>
                        <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                      </svg>
                      {buddyMode && (
                        <button onClick={e => { e.stopPropagation(); handleRemoveFromBuddy(s); }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: buddyColor, marginLeft: '0.25rem', fontSize: '0.85rem', lineHeight: 1, padding: 0 }}
                          title={t.removeFromBuddyGroup}>×</button>
                      )}
                    </>
                  )}
                  {buddyMode && isFirstInBuddy && s.buddy_group && (
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={e => { e.stopPropagation(); handleUngroupBuddy(s.buddy_group!.id); }}
                      style={{ marginLeft: '0.5rem', fontSize: '0.7rem', padding: '0.1rem 0.35rem' }}
                    >{t.ungroup}</button>
                  )}
                </td>
                <td>{s.membership_id}</td>
                <td>{s.attended_sessions}</td>
                <td>{s.no_show_count}</td>
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
                  <button
                    className="btn btn-outline btn-sm"
                    title={t.invitationHistory}
                    style={{ padding: '0.25rem 0.5rem', lineHeight: 1 }}
                    onClick={(e) => { e.stopPropagation(); openHistory(s); }}
                  >
                    <svg style={{ width: '16px', height: '16px', verticalAlign: 'middle' }} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                      <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                    </svg>
                  </button>
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
                  <td colSpan={buddyMode ? 9 : 8} style={{ background: 'var(--bg)', padding: '1rem 1.5rem' }}>
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
                        <strong>{t.group}:</strong>
                        {s.group ? (
                          <div style={{ marginLeft: '0.25rem', marginTop: '0.25rem', display: 'flex', alignItems: 'center' }}>
                            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: s.group.color || '#999', marginRight: 8, flexShrink: 0 }} />{s.group.name}
                          </div>
                        ) : <span> {t.noData}</span>}
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

      {historyModal && (
        <div className="modal-overlay modal-overlay-blur" onClick={() => setHistoryModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: '920px', display: 'flex', flexDirection: 'column' }}>
            <h2>{t.invitationHistory} — {historyModal.first_name} {historyModal.last_name}</h2>
            {historyLoading ? (
              <p>{t.loading}</p>
            ) : historyEntries.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>{t.noInvitationHistory}</p>
            ) : (
              <div style={{ overflowY: 'auto', maxHeight: '60vh' }}>
                <table>
                  <thead>
                    <tr>
                      <th>{t.invitationHistorySession}</th>
                      <th>{t.timeslot}</th>
                      <th>{t.group}</th>
                      <th>{t.invitationHistoryInvitedAt}</th>
                      <th>{t.invitationHistoryRespondedAt}</th>
                      <th>{t.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyEntries.map(inv => {
                      const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
                      const sessionDate = new Date(inv.session_date + 'T00:00:00').toLocaleDateString(dateLocale);
                      return (
                        <tr key={inv.id}>
                          <td>{sessionDate}</td>
                          <td>{inv.start_time.slice(0, 5)}</td>
                          <td>
                            {inv.group_name ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: inv.group_color || '#999', marginRight: 8, flexShrink: 0 }} />
                                {inv.group_name}
                              </span>
                            ) : t.noData}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatInvitedAt(inv.invited_at)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{inv.responded_at ? formatInvitedAt(inv.responded_at) : t.noData}</td>
                          <td>
                            <span className={`badge ${invitationBadgeClass(inv.status)}`}>
                              {t.statusMap(inv.status)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setHistoryModal(null)}>{t.close}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
