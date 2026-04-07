import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

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
  instructor_id: number;
  instructor_name: string;
  discipline_name: string | null;
  status: string;
  token: string;
  timeslot_id: number;
  timeslot_start_time: string;
  no_show: number;
  group_name: string | null;
  group_color: string | null;
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
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export default function SessionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [allInstructors, setAllInstructors] = useState<Instructor[]>([]);
  const [allTimetables, setAllTimetables] = useState<TimetableInfo[]>([]);
  const [selectedInstructor, setSelectedInstructor] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');

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

  const assignInstructor = async () => {
    if (!selectedInstructor) return;
    try {
      await api.assignInstructor(Number(id), Number(selectedInstructor));
      setSelectedInstructor('');
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const removeInstructor = async (instructorId: number) => {
    try {
      await api.removeInstructor(Number(id), instructorId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const changeTimetable = async (timetableId: string) => {
    const newTtId = timetableId ? Number(timetableId) : null;
    if (session?.status === 'scheduled') {
      if (!confirm('Changing the timetable will clear the generated schedule and reset the session to draft. Continue?')) return;
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

  const completeSession = async () => {
    if (!confirm('Mark this session as completed? This will update attendance counts.')) return;
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

  if (loading) return <div className="page"><p>Loading...</p></div>;
  if (!session) return <div className="page"><p>Session not found</p></div>;

  const assignedIds = new Set(session.instructors.map(i => i.id));
  const availableInstructors = allInstructors.filter(i => !assignedIds.has(i.id));

  const confirmed = session.invitations.filter(i => i.status === 'confirmed').length;
  const declined = session.invitations.filter(i => i.status === 'declined').length;
  const invited = session.invitations.filter(i => i.status === 'invited').length;
  const scheduled = session.invitations.filter(i => i.status === 'scheduled').length;

  // Build schedule grid: timeslots as rows, instructors as columns
  const scheduleGrid: Record<number, Record<number, Invitation | undefined>> = {};
  for (const ts of session.timeslots) {
    scheduleGrid[ts.id] = {};
  }
  for (const inv of session.invitations) {
    if (inv.status !== 'declined') {
      scheduleGrid[inv.timeslot_id] ??= {};
      scheduleGrid[inv.timeslot_id][inv.instructor_id] = inv;
    }
  }

  const exportPdf = () => {
    const doc = new jsPDF();
    const dateStr = formatDate(session.date);
    doc.setFontSize(16);
    doc.text(`Schedule — ${dateStr}`, 14, 20);

    const head = [['Time', ...session.instructors.map(i => `${i.first_name} ${i.last_name}`)]];
    const body = session.timeslots.map(ts => {
      const row: string[] = [ts.start_time];
      for (const instr of session.instructors) {
        const inv = scheduleGrid[ts.id]?.[instr.id];
        row.push(inv ? inv.student_name : '');
      }
      return row;
    });

    autoTable(doc, {
      startY: 28,
      head,
      body,
      styles: { fontSize: 10 },
      headStyles: { fillColor: [37, 99, 235] },
    });

    doc.save(`schedule-${session.date}.pdf`);
  };

  return (
    <div className="page">
      <button className="btn btn-outline" onClick={() => navigate('/sessions')} style={{ marginBottom: '1rem' }}>
        ← Back to Sessions
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
          {session.status.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Instructors Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>Instructors ({session.instructors.length})</h2>
        {session.status === 'draft' && (
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <select value={selectedInstructor} onChange={e => setSelectedInstructor(e.target.value)}>
              <option value="">Select instructor...</option>
              {availableInstructors.map(i => (
                <option key={i.id} value={i.id}>{i.first_name} {i.last_name}</option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={assignInstructor} disabled={!selectedInstructor}>Assign</button>
          </div>
        )}
        {session.instructors.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No instructors assigned yet.</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {session.instructors.map(i => (
              <span key={i.id} className="badge badge-confirmed" style={{ fontSize: '0.95rem', padding: '0.4rem 0.8rem' }}>
                {i.first_name} {i.last_name}
                {session.status === 'draft' && (
                  <button onClick={() => removeInstructor(i.id)} style={{ marginLeft: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Timetable Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>Timetable</h2>
        {(session.status === 'draft' || session.status === 'scheduled') ? (
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center' }}>
            <select
              value={session.timetable_id ?? ''}
              onChange={e => changeTimetable(e.target.value)}
            >
              <option value="">No timetable</option>
              {allTimetables.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
              {/* Show current timetable even if not in the active list */}
              {session.timetable && !allTimetables.some(t => t.id === session.timetable!.id) && (
                <option value={session.timetable.id}>{session.timetable.name} (inactive)</option>
              )}
            </select>
          </div>
        ) : (
          <p style={{ marginBottom: '0.5rem' }}>
            {session.timetable ? session.timetable.name : 'No timetable attached'}
          </p>
        )}
        {session.timeslots.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No timeslots{session.timetable_id ? ' in the attached timetable' : ' — attach a timetable first'}.</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {session.timeslots.map(ts => (
              <span key={ts.id} className="badge badge-pending" style={{ fontSize: '0.95rem', padding: '0.4rem 0.8rem' }}>
                {ts.start_time}
              </span>
            ))}
          </div>
        )}
        <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '0.5rem' }}>
          Each timeslot has space for one student per instructor ({session.timeslots.length * session.instructors.length} total slots).
        </p>
      </div>

      {/* Actions */}
      {session.status === 'draft' && session.instructors.length > 0 && session.timetable_id && session.timeslots.length > 0 && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>Actions</h2>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={generateSchedule} disabled={actionLoading === 'generating'}>
              {actionLoading === 'generating' ? 'Generating...' : 'Generate Schedule'}
            </button>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '0.5rem' }}>
            This will select students with the fewest attended sessions and create invitations.
          </p>
        </div>
      )}

      {session.status === 'scheduled' && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>Actions</h2>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={sendInvitations} disabled={actionLoading === 'sending'}>
              {actionLoading === 'sending' ? 'Sending...' : 'Send Invitations'}
            </button>
            <button className="btn btn-outline" onClick={generateSchedule} disabled={actionLoading === 'generating'}>
              {actionLoading === 'generating' ? 'Regenerating...' : 'Regenerate Schedule'}
            </button>
          </div>
        </div>
      )}

      {session.status === 'invitations_sent' && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>Actions</h2>
          <button className="btn btn-primary" onClick={completeSession} disabled={actionLoading === 'completing'}>
            {actionLoading === 'completing' ? 'Completing...' : 'Mark as Completed'}
          </button>
        </div>
      )}

      {/* Schedule Grid: Instructors × Timeslots */}
      {session.invitations.length > 0 && session.instructors.length > 0 && session.timeslots.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <div className="page-header">
            <h2>Schedule Overview</h2>
            <button className="btn btn-outline" onClick={exportPdf}>Export PDF</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Time</th>
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
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                            {inv.group_color && (
                              <span title={inv.group_name || ''} style={{
                                width: '10px', height: '10px', borderRadius: '50%',
                                background: inv.group_color, display: 'inline-block', flexShrink: 0,
                              }} />
                            )}
                            {inv.student_name}
                            <span className={`badge ${
                              inv.status === 'confirmed' ? 'badge-confirmed' :
                              inv.status === 'declined' ? 'badge-declined' :
                              inv.status === 'scheduled' ? 'badge-draft' :
                              'badge-pending'
                            }`} style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem' }}>
                              {inv.status}
                            </span>
                          </span>
                        ) : '—'}
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
      {session.invitations.length > 0 && (
        <div>
          <h2>Invitations ({session.invitations.length})</h2>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
            <span className="badge badge-confirmed">Confirmed: {confirmed}</span>
            <span className="badge badge-pending">Invited: {invited}</span>
            {scheduled > 0 && <span className="badge badge-draft">Scheduled: {scheduled}</span>}
            <span className="badge badge-declined">Declined: {declined}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Timeslot</th>
                <th>Student</th>
                <th>Discipline</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {session.invitations.map(inv => (
                <tr key={inv.id}>
                  <td>{inv.timeslot_start_time}</td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                      {inv.group_color && (
                        <span title={inv.group_name || ''} style={{
                          width: '10px', height: '10px', borderRadius: '50%',
                          background: inv.group_color, display: 'inline-block', flexShrink: 0,
                        }} />
                      )}
                      {inv.student_name}
                    </span>
                  </td>
                  <td>{inv.discipline_name || '—'}</td>
                  <td>
                    <span className={`badge ${
                      inv.status === 'confirmed' ? 'badge-confirmed' :
                      inv.status === 'declined' ? 'badge-declined' :
                      inv.status === 'scheduled' ? 'badge-draft' :
                      'badge-pending'
                    }`}>
                      {inv.status}
                    </span>
                    {inv.status === 'confirmed' && session.status !== 'completed' && (
                      <span
                        className={`badge ${inv.no_show ? 'badge-no-show' : 'badge-show'}`}
                        style={{ marginLeft: '0.5rem', cursor: 'pointer' }}
                        onClick={() => toggleNoShow(inv.id)}
                      >
                        {inv.no_show ? 'no-show' : 'show'}
                      </span>
                    )}
                    {inv.status === 'confirmed' && session.status === 'completed' && (
                      <span
                        className={`badge ${inv.no_show ? 'badge-no-show' : 'badge-show'}`}
                        style={{ marginLeft: '0.5rem' }}
                      >
                        {inv.no_show ? 'no-show' : 'show'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
