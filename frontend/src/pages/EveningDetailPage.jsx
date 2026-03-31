import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function EveningDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [evening, setEvening] = useState(null);
  const [allInstructors, setAllInstructors] = useState([]);
  const [selectedInstructor, setSelectedInstructor] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = async () => {
    try {
      const [ev, instructors] = await Promise.all([
        api.getEvening(id),
        api.getInstructors(),
      ]);
      setEvening(ev);
      setAllInstructors(instructors.filter(i => i.active));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const assignInstructor = async () => {
    if (!selectedInstructor) return;
    setError('');
    try {
      await api.assignInstructor(id, selectedInstructor);
      setSelectedInstructor('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeInstructor = async (instructorId) => {
    try {
      await api.removeInstructor(id, instructorId);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const generateSchedule = async () => {
    if (!confirm('This will regenerate the schedule and replace any existing invitations. Continue?')) return;
    setError('');
    setInfo('');
    try {
      const result = await api.generateSchedule(id);
      setInfo(`Schedule generated: ${result.students_invited} students invited (${result.total_slots} slots available)`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const sendInvitations = async () => {
    setError('');
    setInfo('');
    try {
      const result = await api.sendInvitations(id);
      setInfo(`Sent ${result.sent} invitation email(s)` + (result.errors?.length ? ` (${result.errors.length} failed)` : ''));
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const completeEvening = async () => {
    if (!confirm('Mark this evening as completed? This will credit attended sessions to confirmed students.')) return;
    setError('');
    try {
      const result = await api.completeEvening(id);
      setInfo(`Evening completed. ${result.students_credited} student(s) credited.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;
  if (!evening) return <div className="page"><p>Evening not found.</p></div>;

  const assignedIds = new Set(evening.instructors.map(i => i.id));
  const availableInstructors = allInstructors.filter(i => !assignedIds.has(i.id));
  const isCompleted = evening.status === 'completed';

  const confirmed = evening.invitations.filter(i => i.status === 'confirmed').length;
  const declined = evening.invitations.filter(i => i.status === 'declined').length;
  const pending = evening.invitations.filter(i => i.status === 'invited').length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <button className="btn btn-outline btn-sm" onClick={() => navigate('/evenings')} style={{ marginBottom: 8 }}>
            ← Back
          </button>
          <h1>{formatDate(evening.date)}</h1>
        </div>
        <span className={`badge badge-${evening.status}`} style={{ fontSize: 14, padding: '4px 14px' }}>
          {evening.status}
        </span>
      </div>

      {evening.notes && <div className="alert alert-info">{evening.notes}</div>}
      {error && <div className="alert alert-error">{error}</div>}
      {info && <div className="alert alert-success">{info}</div>}

      {/* Stats */}
      <div className="stats">
        <div className="stat-card">
          <div className="label">Instructors</div>
          <div className="value">{evening.instructors.length}</div>
        </div>
        <div className="stat-card">
          <div className="label">Confirmed</div>
          <div className="value" style={{ color: 'var(--success)' }}>{confirmed}</div>
        </div>
        <div className="stat-card">
          <div className="label">Pending</div>
          <div className="value" style={{ color: 'var(--warning)' }}>{pending}</div>
        </div>
        <div className="stat-card">
          <div className="label">Declined</div>
          <div className="value" style={{ color: 'var(--danger)' }}>{declined}</div>
        </div>
      </div>

      {/* Instructors Section */}
      <div className="card">
        <div className="section-header" style={{ marginTop: 0 }}>
          <h2>Assigned Instructors</h2>
        </div>

        {evening.instructors.length > 0 ? (
          <table>
            <thead>
              <tr><th>Name</th><th>Email</th>{!isCompleted && <th>Actions</th>}</tr>
            </thead>
            <tbody>
              {evening.instructors.map(inst => (
                <tr key={inst.id}>
                  <td>{inst.name}</td>
                  <td>{inst.email}</td>
                  {!isCompleted && (
                    <td>
                      <button className="btn btn-danger btn-sm" onClick={() => removeInstructor(inst.id)}>Remove</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>No instructors assigned yet.</p>
        )}

        {!isCompleted && availableInstructors.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <select
              value={selectedInstructor}
              onChange={e => setSelectedInstructor(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14, flex: 1 }}
            >
              <option value="">Select an instructor...</option>
              {availableInstructors.map(i => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={assignInstructor} disabled={!selectedInstructor}>
              Assign
            </button>
          </div>
        )}
      </div>

      {/* Actions */}
      {!isCompleted && (
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Actions</h2>
          <div className="btn-group" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={generateSchedule} disabled={evening.instructors.length === 0}>
              Generate Schedule
            </button>
            <button className="btn btn-warning" onClick={sendInvitations} disabled={evening.invitations.length === 0}>
              Send Invitation Emails
            </button>
            <button className="btn btn-success" onClick={completeEvening} disabled={evening.invitations.length === 0}>
              Mark as Completed
            </button>
          </div>
        </div>
      )}

      {/* Invitations */}
      {evening.invitations.length > 0 && (
        <div className="card">
          <div className="section-header" style={{ marginTop: 0 }}>
            <h2>Student Invitations</h2>
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Student</th>
                <th>Email</th>
                <th>Sessions Attended</th>
                <th>Discipline</th>
                <th>Status</th>
                <th>Email Sent</th>
              </tr>
            </thead>
            <tbody>
              {evening.invitations.map(inv => (
                <tr key={inv.id}>
                  <td>{inv.slot_number}</td>
                  <td>{inv.student_name}</td>
                  <td>{inv.student_email}</td>
                  <td>{inv.attended_sessions}</td>
                  <td>{inv.discipline_name || '—'}</td>
                  <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                  <td>{inv.email_sent ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
