import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';

interface Invitation {
  id: number;
  student_name: string;
  date: string;
  start_time: string;
  status: string;
  discipline_id: number | null;
}

interface Discipline {
  id: number;
  name: string;
}

export default function InvitationPage() {
  const { token } = useParams();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);
  const [selectedDiscipline, setSelectedDiscipline] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionDone, setActionDone] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const [inv, discs] = await Promise.all([
          api.getInvitation(token!),
          api.getPublicDisciplines()
        ]);
        setInvitation(inv);
        setDisciplines(discs);
        if (inv.discipline_id) {
          setSelectedDiscipline(String(inv.discipline_id));
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [token]);

  const handleConfirm = async () => {
    try {
      await api.confirmInvitation(token!, selectedDiscipline ? Number(selectedDiscipline) : undefined);
      setInvitation({ ...invitation!, status: 'confirmed' });
      setActionDone('confirmed');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDecline = async () => {
    try {
      await api.declineInvitation(token!);
      setInvitation({ ...invitation!, status: 'declined' });
      setActionDone('declined');
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) return <div className="invitation-page"><p>Loading...</p></div>;
  if (error) return <div className="invitation-page"><div className="alert alert-error">{error}</div></div>;
  if (!invitation) return <div className="invitation-page"><p>Invitation not found.</p></div>;

  const dateStr = new Date(invitation.date + 'T00:00:00')
    .toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="invitation-page">
      <div className="card" style={{ maxWidth: 500, margin: '2rem auto', padding: '2rem' }}>
        <h1 style={{ marginBottom: '1.5rem' }}>Training Invitation</h1>

        <div style={{ marginBottom: '1.5rem' }}>
          <p><strong>Student:</strong> {invitation.student_name}</p>
          <p><strong>Date:</strong> {dateStr}</p>
          <p><strong>Time:</strong> {invitation.start_time}</p>
          <p><strong>Status:</strong>{' '}
            <span className={`badge ${
              invitation.status === 'confirmed' ? 'badge-confirmed' :
              invitation.status === 'declined' ? 'badge-declined' :
              'badge-pending'
            }`}>
              {invitation.status}
            </span>
          </p>
        </div>

        {actionDone === 'confirmed' && (
          <div className="alert alert-success">
            Your attendance has been confirmed. See you at the training!
          </div>
        )}

        {actionDone === 'declined' && (
          <div className="alert alert-error">
            You have declined this invitation. Another student will be invited in your place.
          </div>
        )}

        {invitation.status === 'pending' && !actionDone && (
          <>
            {disciplines.length > 0 && (
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label>Preferred Discipline</label>
                <select value={selectedDiscipline} onChange={e => setSelectedDiscipline(e.target.value)}>
                  <option value="">No preference</option>
                  {disciplines.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleConfirm}>
                Confirm Attendance
              </button>
              <button className="btn btn-danger" style={{ flex: 1 }} onClick={handleDecline}>
                Decline
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
