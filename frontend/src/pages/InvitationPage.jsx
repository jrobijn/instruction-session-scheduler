import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';

export default function InvitationPage() {
  const { token } = useParams();
  const [invitation, setInvitation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [responded, setResponded] = useState(false);
  const [responseMessage, setResponseMessage] = useState('');

  useEffect(() => {
    api.getInvitation(token)
      .then(data => setInvitation(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleConfirm = async () => {
    try {
      const result = await api.confirmInvitation(token);
      setResponseMessage(result.message);
      setResponded(true);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDecline = async () => {
    try {
      const result = await api.declineInvitation(token);
      setResponseMessage(result.message);
      setResponded(true);
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="invitation-page">
        <div className="invitation-card">
          <p>Loading invitation...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="invitation-page">
        <div className="invitation-card">
          <h1>Oops!</h1>
          <p style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p>
        </div>
      </div>
    );
  }

  if (responded) {
    return (
      <div className="invitation-page">
        <div className="invitation-card">
          <h1>Thank you!</h1>
          <p style={{ marginTop: 12, fontSize: 16 }}>{responseMessage}</p>
        </div>
      </div>
    );
  }

  if (invitation.status !== 'invited') {
    return (
      <div className="invitation-page">
        <div className="invitation-card">
          <h1>Invitation Already Responded</h1>
          <p style={{ marginTop: 12 }}>
            You have already <strong>{invitation.status}</strong> this invitation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="invitation-page">
      <div className="invitation-card">
        <h1>Coaching Session Invitation</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: 8 }}>{invitation.club_name}</p>
        <div className="date">{formatDate(invitation.date)}</div>

        <p>Hi <strong>{invitation.student_name}</strong>,</p>
        <p style={{ marginTop: 8 }}>You have been invited to a coaching session. Would you like to attend?</p>

        {invitation.notes && (
          <p style={{ marginTop: 12, fontStyle: 'italic', color: 'var(--text-muted)' }}>
            {invitation.notes}
          </p>
        )}

        <div className="actions">
          <button className="btn btn-success" onClick={handleConfirm}>Yes, I'll be there!</button>
          <button className="btn btn-danger" onClick={handleDecline}>Sorry, can't make it</button>
        </div>
      </div>
    </div>
  );
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
