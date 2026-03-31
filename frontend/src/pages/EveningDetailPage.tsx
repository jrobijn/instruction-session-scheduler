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
  evening_id: number;
  start_time: string;
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
}

interface EveningDetail {
  id: number;
  date: string;
  status: string;
  instructors: Instructor[];
  timeslots: Timeslot[];
  invitations: Invitation[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export default function EveningDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [evening, setEvening] = useState<EveningDetail | null>(null);
  const [allInstructors, setAllInstructors] = useState<Instructor[]>([]);
  const [selectedInstructor, setSelectedInstructor] = useState('');
  const [newTimeslotTime, setNewTimeslotTime] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');

  const load = async () => {
    try {
      const [ev, instr] = await Promise.all([
        api.getEvening(Number(id)),
        api.getInstructors()
      ]);
      setEvening(ev);
      setAllInstructors(instr);
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

  const addTimeslot = async () => {
    if (!newTimeslotTime) return;
    try {
      await api.addTimeslot(Number(id), newTimeslotTime);
      setNewTimeslotTime('');
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const deleteTimeslot = async (timeslotId: number) => {
    try {
      await api.deleteTimeslot(Number(id), timeslotId);
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

  const completeEvening = async () => {
    if (!confirm('Mark this evening as completed? This will update attendance counts.')) return;
    setActionLoading('completing');
    try {
      await api.completeEvening(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading('');
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;
  if (!evening) return <div className="page"><p>Evening not found</p></div>;

  const assignedIds = new Set(evening.instructors.map(i => i.id));
  const availableInstructors = allInstructors.filter(i => !assignedIds.has(i.id));

  const confirmed = evening.invitations.filter(i => i.status === 'confirmed').length;
  const declined = evening.invitations.filter(i => i.status === 'declined').length;
  const pending = evening.invitations.filter(i => i.status === 'pending').length;

  // Build schedule grid: timeslots as rows, instructors as columns
  const scheduleGrid: Record<number, Record<number, Invitation | undefined>> = {};
  for (const ts of evening.timeslots) {
    scheduleGrid[ts.id] = {};
  }
  for (const inv of evening.invitations) {
    if (inv.status !== 'declined') {
      scheduleGrid[inv.timeslot_id] ??= {};
      scheduleGrid[inv.timeslot_id][inv.instructor_id] = inv;
    }
  }

  const exportPdf = () => {
    const doc = new jsPDF();
    const dateStr = formatDate(evening.date);
    doc.setFontSize(16);
    doc.text(`Schedule — ${dateStr}`, 14, 20);

    const head = [['Time', ...evening.instructors.map(i => `${i.first_name} ${i.last_name}`)]];
    const body = evening.timeslots.map(ts => {
      const row: string[] = [ts.start_time];
      for (const instr of evening.instructors) {
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

    doc.save(`schedule-${evening.date}.pdf`);
  };

  return (
    <div className="page">
      <button className="btn btn-outline" onClick={() => navigate('/evenings')} style={{ marginBottom: '1rem' }}>
        ← Back to Evenings
      </button>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="page-header">
        <h1>{formatDate(evening.date)}</h1>
        <span className={`badge ${
          evening.status === 'completed' ? 'badge-confirmed' :
          evening.status === 'invitations_sent' ? 'badge-pending' :
          'badge-declined'
        }`}>
          {evening.status.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Instructors Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>Instructors ({evening.instructors.length})</h2>
        {evening.status === 'draft' && (
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
        {evening.instructors.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No instructors assigned yet.</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {evening.instructors.map(i => (
              <span key={i.id} className="badge badge-confirmed" style={{ fontSize: '0.95rem', padding: '0.4rem 0.8rem' }}>
                {i.first_name} {i.last_name}
                {evening.status === 'draft' && (
                  <button onClick={() => removeInstructor(i.id)} style={{ marginLeft: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Timeslots Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>Timeslots ({evening.timeslots.length})</h2>
        {evening.status === 'draft' && (
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <input type="time" value={newTimeslotTime} onChange={e => setNewTimeslotTime(e.target.value)} />
            <button className="btn btn-primary" onClick={addTimeslot} disabled={!newTimeslotTime}>Add Timeslot</button>
          </div>
        )}
        {evening.timeslots.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No timeslots defined yet.</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {evening.timeslots.map(ts => (
              <span key={ts.id} className="badge badge-pending" style={{ fontSize: '0.95rem', padding: '0.4rem 0.8rem' }}>
                {ts.start_time}
                {evening.status === 'draft' && (
                  <button onClick={() => deleteTimeslot(ts.id)} style={{ marginLeft: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
        <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '0.5rem' }}>
          Each timeslot has space for one student per instructor ({evening.timeslots.length * evening.instructors.length} total slots).
        </p>
      </div>

      {/* Actions */}
      {evening.status === 'draft' && evening.instructors.length > 0 && evening.timeslots.length > 0 && (
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

      {evening.status === 'scheduled' && (
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

      {evening.status === 'invitations_sent' && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>Actions</h2>
          <button className="btn btn-primary" onClick={completeEvening} disabled={actionLoading === 'completing'}>
            {actionLoading === 'completing' ? 'Completing...' : 'Mark as Completed'}
          </button>
        </div>
      )}

      {/* Schedule Grid: Instructors × Timeslots */}
      {evening.invitations.length > 0 && evening.instructors.length > 0 && evening.timeslots.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <div className="page-header">
            <h2>Schedule Overview</h2>
            <button className="btn btn-outline" onClick={exportPdf}>Export PDF</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                {evening.instructors.map(i => (
                  <th key={i.id}>{i.first_name} {i.last_name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {evening.timeslots.map(ts => (
                <tr key={ts.id}>
                  <td><strong>{ts.start_time}</strong></td>
                  {evening.instructors.map(instr => {
                    const inv = scheduleGrid[ts.id]?.[instr.id];
                    return (
                      <td key={instr.id}>
                        {inv ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                            {inv.student_name}
                            <span className={`badge ${
                              inv.status === 'confirmed' ? 'badge-confirmed' :
                              inv.status === 'declined' ? 'badge-declined' :
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
      {evening.invitations.length > 0 && (
        <div>
          <h2>Invitations ({evening.invitations.length})</h2>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
            <span className="badge badge-confirmed">Confirmed: {confirmed}</span>
            <span className="badge badge-pending">Pending: {pending}</span>
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
              {evening.invitations.map(inv => (
                <tr key={inv.id}>
                  <td>{inv.timeslot_start_time}</td>
                  <td>{inv.student_name}</td>
                  <td>{inv.discipline_name || '—'}</td>
                  <td>
                    <span className={`badge ${
                      inv.status === 'confirmed' ? 'badge-confirmed' :
                      inv.status === 'declined' ? 'badge-declined' :
                      'badge-pending'
                    }`}>
                      {inv.status}
                    </span>
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
