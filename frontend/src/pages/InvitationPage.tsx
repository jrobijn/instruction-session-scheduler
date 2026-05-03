import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useT, setLocale } from '../i18n';

interface Invitation {
  id: number;
  student_name: string;
  date: string;
  start_time: string;
  status: string;
  discipline_id: number | null;
  discipline_name: string | null;
  expires_at: string | null;
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
  const [confirmingAction, setConfirmingAction] = useState<'confirm' | 'decline' | 'cancel' | null>(null);
  const t = useT();

  useEffect(() => { document.title = t.appTitle; }, [t.appTitle]);

  useEffect(() => {
    const load = async () => {
      try {
        const [inv, discs] = await Promise.all([
          api.getInvitation(token!),
          api.getPublicDisciplinesForToken(token!),
        ]);
        setInvitation(inv);
        setDisciplines(discs);
        if (inv.locale) {
          setLocale(inv.locale);
        }
        if (inv.discipline_id) {
          setSelectedDiscipline(String(inv.discipline_id));
        } else if (discs.length === 1) {
          setSelectedDiscipline(String(discs[0].id));
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
      <div className="card" style={{ width: '100%', maxWidth: 560, margin: '2rem auto', padding: '2rem', display: 'flex', flexWrap: 'wrap', gap: '1.5rem', alignItems: 'flex-start', justifyContent: 'center' }}>
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
              invitation.status === 'admin_cancelled' ? 'badge-declined' :
              invitation.status === 'expired' ? 'badge-declined' :
              'badge-pending'
            }`}>
              {t.statusMap(invitation.status)}
            </span>
          </p>
          {invitation.status === 'invited' && invitation.expires_at && (
            <div className="alert" style={{ marginTop: '1rem', background: '#fef3c7', color: '#d97706', border: '1px solid #fde68a' }}>
              {t.expiresAt(
                new Date(invitation.expires_at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }),
                new Date(invitation.expires_at).toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
              )}
            </div>
          )}
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

        {invitation.status === 'admin_cancelled' && !actionDone && (
          <div className="alert alert-error">
            {t.invitationWithdrawnMsg}
          </div>
        )}

        {invitation.status === 'confirmed' && !actionDone && (
          <>
            <div className="alert alert-success" style={{ marginBottom: '1.5rem' }}>
              {t.invitationConfirmedMsg}
            </div>
            {invitation.discipline_name && !confirmingAction && (
              <p style={{ marginBottom: '1rem' }}><strong>{t.discipline}:</strong> {invitation.discipline_name}</p>
            )}
            {confirmingAction === 'cancel' ? (
              <div style={{ padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8 }}>
                <p style={{ margin: '0 0 0.75rem 0' }}>{t.confirmPromptCancel}</p>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <button className="btn btn-danger" style={{ flex: 1 }} onClick={handleCancel}>{t.yesCancel}</button>
                  <button className="btn" style={{ flex: 1 }} onClick={() => setConfirmingAction(null)}>{t.goBack}</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-danger" style={{ width: '100%' }} onClick={() => setConfirmingAction('cancel')}>
                {t.cancelParticipation}
              </button>
            )}
          </>
        )}

        {invitation.status === 'invited' && !actionDone && (
          <>
            {disciplines.length === 1 && !confirmingAction && (
              <p style={{ marginBottom: '1.5rem' }}><strong>{t.discipline}:</strong> {disciplines[0].name}</p>
            )}
            {disciplines.length > 1 && !confirmingAction && (
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label>{t.chooseDiscipline}</label>
                <select value={selectedDiscipline} onChange={e => setSelectedDiscipline(e.target.value)}>
                  <option value="" disabled>{t.selectDiscipline}</option>
                  {disciplines.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
            {confirmingAction === 'confirm' ? (
              <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 }}>
                <p style={{ margin: '0 0 0.75rem 0' }}>{t.confirmPromptConfirm}</p>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleConfirm} disabled={disciplines.length > 1 && !selectedDiscipline}>{t.yesConfirm}</button>
                  <button className="btn" style={{ flex: 1 }} onClick={() => setConfirmingAction(null)}>{t.goBack}</button>
                </div>
              </div>
            ) : confirmingAction === 'decline' ? (
              <div style={{ padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8 }}>
                <p style={{ margin: '0 0 0.75rem 0' }}>{t.confirmPromptDecline}</p>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <button className="btn btn-danger" style={{ flex: 1 }} onClick={handleDecline}>{t.yesDecline}</button>
                  <button className="btn" style={{ flex: 1 }} onClick={() => setConfirmingAction(null)}>{t.goBack}</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '1rem' }}>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setConfirmingAction('confirm')} disabled={disciplines.length > 1 && !selectedDiscipline}>
                  {t.confirmAttendance}
                </button>
                <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => setConfirmingAction('decline')}>
                  {t.decline}
                </button>
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
