import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { useT } from '../i18n';

interface Instructor {
  id: number;
  first_name: string;
  last_name: string;
}

interface Timeslot {
  id: number;
  timetable_id: number;
  start_time: string;
}

interface TimetableInfo {
  id: number;
  name: string;
  status: string;
  active: number;
}

interface Invitation {
  id: number;
  student_name: string;
  student_email: string;
  student_membership_id: string;
  instructor_id: number;
  instructor_name: string;
  discipline_name: string | null;
  discipline_abbreviation: string | null;
  status: string;
  token: string;
  timeslot_id: number;
  timeslot_start_time: string;
  no_show: number;
  group_name: string | null;
  group_color: string | null;
}

interface TimetableGroup {
  group_id: number;
  percentage: number;
  group_name: string;
  group_color: string;
  is_default: number;
}

interface SessionDetail {
  id: number;
  date: string;
  status: string;
  timetable_id: number | null;
  timetable: TimetableInfo | null;
  instructors: Instructor[];
  timeslots: Timeslot[];
  invitations: Invitation[];
  timetableGroups: TimetableGroup[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export default function SessionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [allInstructors, setAllInstructors] = useState<Instructor[]>([]);
  const [allTimetables, setAllTimetables] = useState<TimetableInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [addSlot, setAddSlot] = useState<{ timeslotId: number; instructorId: number } | null>(null);
  const [studentSearch, setStudentSearch] = useState('');
  const [studentResults, setStudentResults] = useState<Array<{ id: number; first_name: string; last_name: string; email: string }>>([]);
  const [showStudentDropdown, setShowStudentDropdown] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement | null>(null);
  const [replacingInstructorId, setReplacingInstructorId] = useState<number | null>(null);
  const [replacementTargetId, setReplacementTargetId] = useState<number | null>(null);
  const [showAddInstructor, setShowAddInstructor] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.src = '/logo.png';
    img.onload = () => { logoRef.current = img; };
  }, []);

  const load = async () => {
    try {
      const [sess, instr, tts] = await Promise.all([
        api.getSession(Number(id)),
        api.getInstructors(),
        api.getTimetables()
      ]);
      setSession(sess);
      setAllInstructors(instr);
      // Only saved + active timetables for selection
      setAllTimetables(tts.filter((t: any) => t.status === 'saved' && t.active));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowStudentDropdown(false);
        setAddSlot(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const searchStudents = (query: string) => {
    setStudentSearch(query);
    clearTimeout(searchTimeout.current);
    if (query.trim().length < 2) { setStudentResults([]); setShowStudentDropdown(false); return; }
    searchTimeout.current = setTimeout(async () => {
      try {
        const results = await api.searchAvailableStudents(Number(id), query.trim());
        setStudentResults(results);
        setShowStudentDropdown(results.length > 0);
      } catch { setStudentResults([]); }
    }, 300);
  };

  const addStudentToSlot = async (studentId: number) => {
    if (!addSlot) return;
    if (session?.status === 'invitations_sent') {
      if (!confirm(t.confirmAddAndInvite)) return;
    }
    try {
      await api.addSessionInvitation(Number(id), {
        student_id: studentId,
        timeslot_id: addSlot.timeslotId,
        instructor_id: addSlot.instructorId,
      });
      setAddSlot(null);
      setStudentSearch('');
      setStudentResults([]);
      setShowStudentDropdown(false);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const removeInvitation = async (invitationId: number) => {
    try {
      await api.removeSessionInvitation(Number(id), invitationId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const removeInstructor = async (instructorId: number) => {
    // Count active invitations that will be cancelled for this instructor
    const activeInvs = session?.invitations.filter(
      inv => inv.instructor_id === instructorId &&
        inv.status !== 'declined' && inv.status !== 'expired' &&
        inv.status !== 'cancelled' && inv.status !== 'admin_cancelled'
    ) || [];
    const sentInvs = activeInvs.filter(inv => inv.status === 'invited' || inv.status === 'confirmed');
    if (sentInvs.length > 0) {
      if (!confirm(t.confirmRemoveInstructor(sentInvs.length))) return;
    }
    try {
      await api.removeInstructor(Number(id), instructorId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const replaceInstructor = async (oldInstructorId: number, newInstructorId: number) => {
    try {
      await api.replaceInstructor(Number(id), oldInstructorId, newInstructorId);
      setReplacingInstructorId(null);
      setReplacementTargetId(null);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const changeTimetable = async (timetableId: string) => {
    const newTtId = timetableId ? Number(timetableId) : null;
    if (session?.status === 'scheduled') {
      if (!confirm(t.confirmTimetableChange)) return;
    }
    try {
      await api.updateSession(String(id), { timetable_id: newTtId });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const generateSchedule = async () => {
    setActionLoading('generating');
    try {
      await api.generateSchedule(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading('');
    }
  };

  const sendInvitations = async () => {
    setActionLoading('sending');
    try {
      await api.sendInvitations(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading('');
    }
  };

  const toggleNoShow = async (invitationId: number) => {
    try {
      await api.toggleNoShow(Number(id), invitationId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const adminCancelInvitation = async (invitationId: number) => {
    if (!confirm(t.confirmAdminCancel)) return;
    try {
      await api.adminCancelInvitation(Number(id), invitationId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const completeSession = async () => {
    if (!confirm(t.confirmComplete)) return;
    setActionLoading('completing');
    try {
      await api.completeSession(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading('');
    }
  };

  const cancelSession = async () => {
    const activeCount = session?.invitations.filter(inv => inv.status === 'invited' || inv.status === 'confirmed').length || 0;
    if (!confirm(t.confirmCancelSession(activeCount))) return;
    setActionLoading('cancelling');
    try {
      await api.cancelSession(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading('');
    }
  };

  if (loading) return <div className="page"><p>{t.loading}</p></div>;
  if (!session) return <div className="page"><p>{t.sessionNotFound}</p></div>;

  const assignedIds = new Set(session.instructors.map(i => i.id));
  const availableInstructors = allInstructors.filter(i => !assignedIds.has(i.id));

  const confirmed = session.invitations.filter(i => i.status === 'confirmed').length;
  const declined = session.invitations.filter(i => i.status === 'declined').length;
  const cancelled = session.invitations.filter(i => i.status === 'cancelled').length;
  const adminCancelled = session.invitations.filter(i => i.status === 'admin_cancelled').length;
  const expired = session.invitations.filter(i => i.status === 'expired').length;
  const invited = session.invitations.filter(i => i.status === 'invited').length;
  const scheduled = session.invitations.filter(i => i.status === 'scheduled').length;

  // Build schedule grid: timeslots as rows, instructors as columns
  const scheduleGrid: Record<number, Record<number, Invitation | undefined>> = {};
  for (const ts of session.timeslots) {
    scheduleGrid[ts.id] = {};
  }
  for (const inv of session.invitations) {
    if (inv.status !== 'declined' && inv.status !== 'expired' && inv.status !== 'cancelled' && inv.status !== 'admin_cancelled') {
      scheduleGrid[inv.timeslot_id] ??= {};
      scheduleGrid[inv.timeslot_id][inv.instructor_id] = inv;
    }
  }

  const canEdit = session.status === 'draft' || session.status === 'scheduled';

  // Build unified slot list for invitations table: every timeslot×instructor gets rows for
  // existing invitations (including declined) plus an empty add-row if the slot is unoccupied
  type SlotEntry = { timeslotId: number; instructorId: number; startTime: string; invitation: Invitation | null; empty: boolean };
  const allSlots: SlotEntry[] = [];
  const assignedInstructorIds = new Set(session.instructors.map(i => i.id));
  for (const ts of session.timeslots) {
    for (const instr of session.instructors) {
      const slotInvitations = session.invitations.filter(
        inv => inv.timeslot_id === ts.id && inv.instructor_id === instr.id
      );
      // Add all invitations for this slot (active + declined)
      for (const inv of slotInvitations) {
        allSlots.push({ timeslotId: ts.id, instructorId: instr.id, startTime: ts.start_time, invitation: inv, empty: false });
      }
      // If no active (non-declined/expired) invitation occupies this slot, add an empty row
      const hasActive = slotInvitations.some(inv => inv.status !== 'declined' && inv.status !== 'expired' && inv.status !== 'cancelled' && inv.status !== 'admin_cancelled');
      if (!hasActive) {
        allSlots.push({ timeslotId: ts.id, instructorId: instr.id, startTime: ts.start_time, invitation: null, empty: true });
      }
    }
  }
  // Add orphaned invitations (instructor was removed from session)
  const orphanedInvitations = session.invitations.filter(
    inv => !assignedInstructorIds.has(inv.instructor_id)
  );
  for (const inv of orphanedInvitations) {
    allSlots.push({ timeslotId: inv.timeslot_id, instructorId: inv.instructor_id, startTime: inv.timeslot_start_time, invitation: inv, empty: false });
  }

  const exportPdf = () => {
    const doc = new jsPDF({ orientation: 'landscape' });
    const dateStr = formatDate(session.date);

    // Add logo
    if (logoRef.current) {
      try {
        doc.addImage(logoRef.current, 'PNG', 14, 10, 16, 16);
      } catch {
        // logo failed, continue without
      }
    }

    doc.setFontSize(16);
    doc.text(t.pdfTitle(dateStr), 34, 22);

    const boxSize = 3.5;
    const boxPad = 2;

    // Each instructor gets 2 columns: student (with checkbox + membership ID subtitle) and discipline abbreviation
    const headerRow: any[] = [{ content: t.time, rowSpan: 2, styles: { cellPadding: 3, halign: 'left' } }];
    for (const instr of session.instructors) {
      headerRow.push({ content: `${instr.first_name} ${instr.last_name}`, colSpan: 2, styles: { halign: 'left' } });
    }
    const subHeaderRow: any[] = [];
    for (let i = 0; i < session.instructors.length; i++) {
      subHeaderRow.push({ content: 'Student', styles: { fontSize: 8, fontStyle: 'italic' } });
      subHeaderRow.push({ content: 'Disc.', styles: { fontSize: 8, fontStyle: 'italic' } });
    }

    const subtitles: Record<string, string> = {};
    const body = session.timeslots.map((ts, rowIdx) => {
      const row: string[] = [ts.start_time];
      session.instructors.forEach((instr, colIdx) => {
        const inv = scheduleGrid[ts.id]?.[instr.id];
        row.push(inv ? inv.student_name : '');
        row.push(inv?.discipline_abbreviation || '');
        if (inv?.student_membership_id) {
          const studentColIdx = 1 + colIdx * 2;
          subtitles[`${rowIdx}-${studentColIdx}`] = inv.student_membership_id;
        }
      });
      return row;
    });

    // Build columnStyles: Time col normal padding, discipline cols smaller width
    const colStyles: Record<number, any> = { 0: { cellPadding: 3, halign: 'left' } };
    for (let i = 0; i < session.instructors.length; i++) {
      colStyles[2 + i * 2] = { cellPadding: 3, cellWidth: 18, halign: 'center' };
    }

    autoTable(doc, {
      startY: 28,
      head: [headerRow, subHeaderRow],
      body,
      styles: { fontSize: 10, cellPadding: { top: 3, right: 3, bottom: 6, left: 8 } },
      headStyles: { fillColor: [37, 99, 235], cellPadding: { top: 3, right: 3, bottom: 3, left: 8 } },
      columnStyles: colStyles,
      didDrawCell: (data: any) => {
        if (data.section !== 'body' || data.column.index === 0) return;
        // Only draw on student columns (odd indices: 1, 3, 5, ...)
        const isStudentCol = (data.column.index - 1) % 2 === 0;
        if (!isStudentCol) return;
        const key = `${data.row.index}-${data.column.index}`;
        // Draw checkbox
        if (data.cell.raw && String(data.cell.raw).trim()) {
          const x = data.cell.x + boxPad;
          const y = data.cell.y + 3 + (10 * 0.3528 - boxSize) / 2;
          doc.setDrawColor(0);
          doc.setLineWidth(0.3);
          doc.rect(x, y, boxSize, boxSize);
        }
        // Draw membership ID subtitle
        if (subtitles[key]) {
          const nameBaselineY = data.cell.y + 3 + 10 * 0.3528;
          doc.setFontSize(7);
          doc.setFont('helvetica', 'italic');
          doc.setTextColor(120, 120, 120);
          doc.text(subtitles[key], data.cell.x + 8, nameBaselineY + 3);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(0, 0, 0);
          doc.setFontSize(10);
        }
      },
    });

    doc.save(`schedule-${session.date}.pdf`);
  };

  return (
    <div className="page">
      <button className="btn btn-outline" onClick={() => navigate('/sessions')} style={{ marginBottom: '1rem' }}>
        {t.backToSessions}
      </button>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="page-header">
        <h1>{formatDate(session.date)}</h1>
        <span className={`badge ${
          session.status === 'completed' ? 'badge-confirmed' :
          session.status === 'invitations_sent' ? 'badge-pending' :
          session.status === 'scheduled' ? 'badge-pending' :
          session.status === 'draft' ? 'badge-draft' :
          'badge-declined'
        }`}>
          {t.statusMap(session.status)}
        </span>
      </div>

      {/* Instructors Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>{t.instructorsCount(session.instructors.length)}</h2>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {session.instructors.map(i => (
              <span key={i.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                {replacingInstructorId === i.id ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', background: '#475569', color: '#ffffff', borderRadius: '12px', padding: '0.4rem 0.8rem', fontSize: '0.95rem', fontWeight: 600 }}>
                    <span>{i.first_name} {i.last_name}</span>
                    <span style={{ color: '#cbd5e1' }}>→</span>
                    <select
                      autoFocus
                      value={replacementTargetId ?? ''}
                      onChange={e => setReplacementTargetId(e.target.value ? Number(e.target.value) : null)}
                      style={{ fontSize: '0.85rem', padding: '0.2rem 0.4rem', borderRadius: '0.25rem', border: '1px solid #94a3b8', background: '#334155', color: '#ffffff' }}
                    >
                      <option value="">{t.replaceWith}</option>
                      {allInstructors.filter(inst => !assignedIds.has(inst.id)).map(inst => (
                        <option key={inst.id} value={inst.id}>{inst.first_name} {inst.last_name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => { if (replacementTargetId) replaceInstructor(i.id, replacementTargetId); }}
                      disabled={!replacementTargetId}
                      title={t.confirm}
                      style={{ background: 'none', border: 'none', cursor: replacementTargetId ? 'pointer' : 'default', fontSize: '1.1rem', color: replacementTargetId ? '#4ade80' : '#64748b', padding: '0 0.2rem' }}
                    >✓</button>
                    <button
                      onClick={() => { setReplacingInstructorId(null); setReplacementTargetId(null); }}
                      title={t.cancel}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: '#f87171', padding: '0 0.2rem' }}
                    >✗</button>
                  </span>
                ) : (
                  <span className="badge" style={{ fontSize: '0.95rem', padding: '0.4rem 0.8rem', background: '#475569', color: '#ffffff' }}>
                    {i.first_name} {i.last_name}
                    {session.status !== 'completed' && session.status !== 'cancelled' && (
                      <>
                        <button onClick={() => { setReplacingInstructorId(i.id); setReplacementTargetId(null); }} title={t.replaceInstructor} style={{ marginLeft: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: '1.05rem' }}>⇄</button>
                        <button onClick={() => removeInstructor(i.id)} style={{ marginLeft: '0.4rem', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: '1.05rem' }}>×</button>
                      </>
                    )}
                  </span>
                )}
              </span>
            ))}
            {(session.status === 'draft' || session.status === 'scheduled' || session.status === 'invitations_sent') && availableInstructors.length > 0 && (
              showAddInstructor ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', background: '#f1f5f9', color: '#1e293b', borderRadius: '12px', padding: '0.4rem 0.8rem', fontSize: '0.95rem', fontWeight: 600, border: '1px solid #cbd5e1' }}>
                  <select
                    autoFocus
                    value=""
                    onChange={async e => {
                      const val = e.target.value;
                      if (!val) return;
                      try {
                        await api.assignInstructor(Number(id), Number(val));
                        setShowAddInstructor(false);
                        load();
                      } catch (err: any) {
                        alert(err.message);
                      }
                    }}
                    onBlur={() => setShowAddInstructor(false)}
                    style={{ fontSize: '0.85rem', padding: '0.2rem 0.4rem', borderRadius: '0.25rem', border: '1px solid #cbd5e1', background: '#ffffff', color: '#1e293b' }}
                  >
                    <option value="">{t.selectInstructor}</option>
                    {availableInstructors.map(inst => (
                      <option key={inst.id} value={inst.id}>{inst.first_name} {inst.last_name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setShowAddInstructor(false)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: '#64748b', padding: '0 0.2rem' }}
                  >✗</button>
                </span>
              ) : (
                <span
                  style={{ fontSize: '0.95rem', padding: '0.4rem 0.9rem', background: '#f1f5f9', color: '#1e293b', border: '1px solid #cbd5e1', cursor: 'pointer', borderRadius: '12px', display: 'inline-flex', alignItems: 'center', fontWeight: 600 }}
                  onClick={() => setShowAddInstructor(true)}
                >
                  +
                </span>
              )
            )}
        </div>
        {session.instructors.length === 0 && !(session.status === 'draft' || session.status === 'scheduled' || session.status === 'invitations_sent') && (
          <p style={{ color: '#6b7280' }}>{t.noInstructorsAssigned}</p>
        )}
      </div>

      {/* Timetable Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>{t.timetableSection}</h2>
        {(session.status === 'draft' || session.status === 'scheduled') ? (
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center' }}>
            <select
              value={session.timetable_id ?? ''}
              onChange={e => changeTimetable(e.target.value)}
            >
              <option value="">{t.noTimetable}</option>
              {allTimetables.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
              {/* Show current timetable even if not in the active list */}
              {session.timetable && !allTimetables.some(t => t.id === session.timetable!.id) && (
                <option value={session.timetable.id}>{session.timetable.name} {t.inactiveSuffix}</option>
              )}
            </select>
          </div>
        ) : (
          <p style={{ marginBottom: '0.5rem' }}>
            {session.timetable ? session.timetable.name : t.noTimetableAttached}
          </p>
        )}
        {session.timeslots.length === 0 ? (
          <p style={{ color: '#6b7280' }}>{session.timetable_id ? t.noTimeslotsInTimetable : t.noTimeslotsAttachFirst}.</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {session.timeslots.map(ts => (
              <span key={ts.id} className="badge" style={{ fontSize: '0.95rem', padding: '0.4rem 0.8rem', background: '#475569', color: '#ffffff' }}>
                {ts.start_time}
              </span>
            ))}
          </div>
        )}
        <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '0.5rem' }}>
          {t.slotsInfo(session.timeslots.length * session.instructors.length)}
        </p>
        {session.timetableGroups.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{
              display: 'flex', height: '32px', borderRadius: '6px', overflow: 'hidden',
              border: '1px solid #e5e7eb', background: '#f3f4f6',
            }}>
              {session.timetableGroups.map((seg, i) => (
                seg.percentage > 0 ? (
                  <div key={i} style={{
                    width: `${seg.percentage}%`,
                    background: seg.group_color || '#3b82f6',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'white', fontSize: '0.8rem', fontWeight: 600,
                    minWidth: '24px',
                    borderRight: i < session.timetableGroups.length - 1 ? '2px solid white' : 'none',
                  }}>
                    {seg.percentage}%
                  </div>
                ) : null
              ))}
            </div>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              {session.timetableGroups.map((seg, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <span style={{
                    width: '12px', height: '12px', borderRadius: '3px',
                    background: seg.group_color || '#3b82f6', display: 'inline-block', flexShrink: 0,
                  }} />
                  {seg.is_default ? t.default : seg.group_name} ({seg.percentage}%)
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      {session.status === 'draft' && session.instructors.length > 0 && session.timetable_id && session.timeslots.length > 0 && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>{t.actions}</h2>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={generateSchedule} disabled={actionLoading === 'generating'}>
              {actionLoading === 'generating' ? t.generating : t.generateSchedule}
            </button>
            <button className="btn btn-danger" onClick={cancelSession} disabled={actionLoading === 'cancelling'}>
              {actionLoading === 'cancelling' ? t.cancelling : t.cancelSession}
            </button>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '0.5rem' }}>
            {t.scheduleHint}
          </p>
        </div>
      )}

      {session.status === 'scheduled' && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>{t.actions}</h2>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={sendInvitations} disabled={actionLoading === 'sending'}>
              {actionLoading === 'sending' ? t.sending : t.sendInvitations}
            </button>
            <button className="btn btn-outline" onClick={generateSchedule} disabled={actionLoading === 'generating'}>
              {actionLoading === 'generating' ? t.regenerating : t.regenerateSchedule}
            </button>
            <button className="btn btn-danger" onClick={cancelSession} disabled={actionLoading === 'cancelling'}>
              {actionLoading === 'cancelling' ? t.cancelling : t.cancelSession}
            </button>
          </div>
        </div>
      )}

      {session.status === 'invitations_sent' && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>{t.actions}</h2>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={completeSession} disabled={actionLoading === 'completing'}>
              {actionLoading === 'completing' ? t.completing : t.markCompleted}
            </button>
            <button className="btn btn-danger" onClick={cancelSession} disabled={actionLoading === 'cancelling'}>
              {actionLoading === 'cancelling' ? t.cancelling : t.cancelSession}
            </button>
          </div>
        </div>
      )}

      {/* Schedule Grid: Instructors × Timeslots */}
      {session.invitations.length > 0 && session.instructors.length > 0 && session.timeslots.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <div className="page-header">
            <h2>{t.scheduleOverview}</h2>
            <button className="btn btn-outline" onClick={exportPdf}>{t.exportPdf}</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>{t.time}</th>
                {session.instructors.map(i => (
                  <th key={i.id}>{i.first_name} {i.last_name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {session.timeslots.map(ts => (
                <tr key={ts.id}>
                  <td><strong>{ts.start_time}</strong></td>
                  {session.instructors.map(instr => {
                    const inv = scheduleGrid[ts.id]?.[instr.id];
                    return (
                      <td key={instr.id}>
                        {inv ? (
                          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span title={inv.group_name || ''} style={{
                                width: '10px', height: '10px', borderRadius: '50%',
                                background: inv.group_color || 'transparent', display: 'inline-block', flexShrink: 0,
                              }} />
                              <span>{inv.student_name}</span>
                              <span className={`badge ${
                                inv.status === 'confirmed' ? 'badge-confirmed' :
                                inv.status === 'declined' ? 'badge-declined' :
                                inv.status === 'cancelled' ? 'badge-declined' :
                                inv.status === 'admin_cancelled' ? 'badge-declined' :
                                inv.status === 'expired' ? 'badge-declined' :
                                inv.status === 'scheduled' ? 'badge-draft' :
                                'badge-pending'
                              }`} style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem' }}>
                                {t.statusMap(inv.status)}
                              </span>
                            </span>
                            <span style={{ fontSize: '0.75rem', fontStyle: 'italic', opacity: inv.discipline_name ? 0.7 : 0, whiteSpace: 'pre', paddingLeft: 'calc(10px + 0.5rem)' }}>{inv.discipline_name || '\u00A0'}</span>
                          </span>
                        ) : t.noData}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Invitations */}
      {(session.invitations.length > 0 || (canEdit && session.timeslots.length > 0 && session.instructors.length > 0)) && (
        <div>
          <h2>{t.invitationsCount(session.invitations.length)}</h2>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
            <span className="badge badge-confirmed">{t.summaryConfirmed(confirmed)}</span>
            <span className="badge badge-pending">{t.summaryInvited(invited)}</span>
            {scheduled > 0 && <span className="badge badge-draft">{t.summaryScheduled(scheduled)}</span>}
            <span className="badge badge-declined">{t.summaryDeclined(declined)}</span>
            {cancelled > 0 && <span className="badge badge-declined">{t.summaryCancelled(cancelled)}</span>}
            {adminCancelled > 0 && <span className="badge badge-declined">{t.summaryWithdrawn(adminCancelled)}</span>}
            {expired > 0 && <span className="badge badge-declined">{t.summaryExpired(expired)}</span>}
          </div>
          <table>
            <thead>
              <tr>
                <th>{t.timeslot}</th>
                <th>{t.student}</th>
                <th>{t.discipline}</th>
                <th>{t.status}</th>
                {(canEdit || session.status === 'invitations_sent') && <th></th>}
              </tr>
            </thead>
            <tbody>
              {allSlots.map((slot, idx) => {
                const inv = slot.invitation;
                if (inv) return (
                  <tr key={inv.id}>
                    <td>{inv.timeslot_start_time}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span title={inv.group_name || ''} style={{
                          width: '10px', height: '10px', borderRadius: '50%',
                          background: inv.group_color || 'transparent', display: 'inline-block', flexShrink: 0,
                        }} />
                        {inv.student_name}
                      </span>
                    </td>
                    <td>{inv.discipline_name || t.noData}</td>
                    <td>
                      <span className={`badge ${
                        inv.status === 'confirmed' ? 'badge-confirmed' :
                        inv.status === 'declined' ? 'badge-declined' :
                        inv.status === 'cancelled' ? 'badge-declined' :
                        inv.status === 'admin_cancelled' ? 'badge-declined' :
                        inv.status === 'expired' ? 'badge-declined' :
                        inv.status === 'scheduled' ? 'badge-draft' :
                        'badge-pending'
                      }`}>
                        {t.statusMap(inv.status)}
                      </span>
                      {inv.status === 'confirmed' && session.status !== 'completed' && (
                        <span
                          className={`badge ${inv.no_show ? 'badge-no-show' : 'badge-show'}`}
                          style={{ marginLeft: '0.5rem', cursor: 'pointer' }}
                          onClick={() => toggleNoShow(inv.id)}
                        >
                          {inv.no_show ? t.noShow : t.show}
                        </span>
                      )}
                      {inv.status === 'confirmed' && session.status === 'completed' && (
                        <span
                          className={`badge ${inv.no_show ? 'badge-no-show' : 'badge-show'}`}
                          style={{ marginLeft: '0.5rem' }}
                        >
                          {inv.no_show ? t.noShow : t.show}
                        </span>
                      )}
                    </td>
                    {canEdit && (
                      <td>
                        {inv.status !== 'declined' && inv.status !== 'expired' && inv.status !== 'cancelled' && inv.status !== 'admin_cancelled' && (
                          <button
                            className="btn btn-outline"
                            style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                            onClick={() => removeInvitation(inv.id)}
                          >×</button>
                        )}
                      </td>
                    )}
                    {!canEdit && session.status === 'invitations_sent' && (
                      <td style={{ display: 'flex', gap: '0.3rem' }}>
                        <button
                          className="btn btn-outline"
                          style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                          onClick={() => window.open(`/invitation/${inv.token}`, '_blank')}
                          title={t.viewInvitation}
                        >↗</button>
                        {inv.status !== 'declined' && inv.status !== 'expired' && inv.status !== 'cancelled' && inv.status !== 'admin_cancelled' && (
                          <button
                            className="btn btn-outline"
                            style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                            onClick={() => adminCancelInvitation(inv.id)}
                          >×</button>
                        )}
                      </td>
                    )}
                  </tr>
                );
                if (!slot.empty || !(canEdit || session.status === 'invitations_sent')) return null;
                return (
                  <tr key={`empty-${slot.timeslotId}-${slot.instructorId}`}>
                    <td>{slot.startTime}</td>
                    <td colSpan={2}>
                      {addSlot?.timeslotId === slot.timeslotId && addSlot?.instructorId === slot.instructorId ? (
                        <div ref={dropdownRef} style={{ position: 'relative' }}>
                          <input
                            type="text"
                            placeholder={t.searchStudent}
                            value={studentSearch}
                            onChange={e => searchStudents(e.target.value)}
                            autoFocus
                            style={{ width: '100%', padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}
                          />
                          {showStudentDropdown && (
                            <div style={{
                              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                              background: 'white', border: '1px solid #d1d5db', borderRadius: '0.375rem',
                              maxHeight: '200px', overflowY: 'auto', boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                            }}>
                              {studentResults.map(s => (
                                <div
                                  key={s.id}
                                  onClick={() => addStudentToSlot(s.id)}
                                  style={{ padding: '0.5rem', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                                  onMouseOver={e => (e.currentTarget.style.background = '#f3f4f6')}
                                  onMouseOut={e => (e.currentTarget.style.background = 'white')}
                                >
                                  {s.first_name} {s.last_name} <span style={{ color: '#6b7280', fontSize: '0.8rem' }}>({s.email})</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <button
                          className="btn btn-outline"
                          style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                          onClick={() => { setAddSlot({ timeslotId: slot.timeslotId, instructorId: slot.instructorId }); setStudentSearch(''); setStudentResults([]); }}
                        >{t.addStudentToSlot}</button>
                      )}
                    </td>
                    <td></td>
                    {(canEdit || session.status === 'invitations_sent') && <td></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
