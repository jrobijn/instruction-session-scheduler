import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useT } from '../i18n';

interface Invitation {
  id: number;
  student_name: string;
  date: string;
  start_time: string;
  status: string;
  discipline_id: number | null;
  discipline_name: string | null;
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
  const t = useT();

  useEffect(() => {
    const load = async () => {
      try {
        const [inv, discs] = await Promise.all([
          api.getInvitation(token!),
          api.getPublicDisciplines(token!),
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

  const handleCancel = async () => {
    try {
      await api.cancelInvitation(token!);
      setInvitation({ ...invitation!, status: 'cancelled' });
      setActionDone('cancelled');
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) return <div className="invitation-page"><p>{t.loading}</p></div>;
  if (error) return <div className="invitation-page"><div className="alert alert-error">{error}</div></div>;
  if (!invitation) return <div className="invitation-page"><p>{t.invitationNotFound}</p></div>;

  const dateStr = new Date(invitation.date + 'T00:00:00')
    .toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="invitation-page">
      <div className="card" style={{ maxWidth: 560, margin: '2rem auto', padding: '2rem', display: 'flex', flexWrap: 'wrap', gap: '1.5rem', alignItems: 'flex-start', justifyContent: 'center' }}>
        <img src="/logo.png" alt="Logo" style={{ width: 128, height: 128, objectFit: 'contain', flexShrink: 0 }} />
        <div style={{ flex: '1 1 280px' }}>
        <h1 style={{ margin: '0 0 1.5rem 0' }}>{t.trainingInvitation}</h1>

        <div style={{ marginBottom: '1.5rem' }}>
          <p><strong>{t.studentLabel}</strong> {invitation.student_name}</p>
          <p><strong>{t.dateLabel}</strong> {dateStr}</p>
          <p><strong>{t.timeLabel}</strong> {invitation.start_time}</p>
          <p><strong>{t.statusLabel}</strong>{' '}
            <span className={`badge ${
              invitation.status === 'confirmed' ? 'badge-confirmed' :
              invitation.status === 'declined' ? 'badge-declined' :
              invitation.status === 'cancelled' ? 'badge-declined' :
              invitation.status === 'expired' ? 'badge-declined' :
              'badge-pending'
            }`}>
              {t.statusMap(invitation.status)}
            </span>
          </p>
        </div>

        {actionDone === 'confirmed' && (
          <div className="alert alert-success">
            {t.invitationConfirmedMsg}
          </div>
        )}

        {actionDone === 'declined' && (
          <div className="alert alert-error">
            {t.invitationDeclinedMsg}
          </div>
        )}

        {actionDone === 'cancelled' && (
          <div className="alert alert-error">
            {t.invitationCancelledMsg}
          </div>
        )}

        {invitation.status === 'expired' && !actionDone && (
          <div className="alert alert-error">
            {t.invitationExpiredMsg}
          </div>
        )}

        {invitation.status === 'confirmed' && !actionDone && (
          <>
            <div className="alert alert-success" style={{ marginBottom: '1.5rem' }}>
              {t.invitationConfirmedMsg}
            </div>
            {invitation.discipline_name && (
              <p style={{ marginBottom: '1rem' }}><strong>{t.discipline}:</strong> {invitation.discipline_name}</p>
            )}
            <button className="btn btn-danger" style={{ width: '100%' }} onClick={handleCancel}>
              {t.cancelParticipation}
            </button>
          </>
        )}

        {invitation.status === 'invited' && !actionDone && (
          <>
            {disciplines.length > 0 && (
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label>{t.preferredDiscipline}</label>
                <select value={selectedDiscipline} onChange={e => setSelectedDiscipline(e.target.value)}>
                  <option value="">{t.noPreference}</option>
                  {disciplines.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleConfirm}>
                {t.confirmAttendance}
              </button>
              <button className="btn btn-danger" style={{ flex: 1, textAlign: 'center' }} onClick={handleDecline}>
                {t.decline}
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
