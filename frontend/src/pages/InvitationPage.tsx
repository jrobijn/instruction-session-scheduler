import { useState, useEffect, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Check, Timer, X } from 'lucide-react';
import { api, API_BASE } from '../api';
import { useT, setLocale, getLocale } from '../i18n';
import { Alert, Badge, Button, Card, CenteredPage, DescriptionList, Field, Row, Select, Stack, Text } from '../ui';
import Countdown from '../components/Countdown';
import Logo from '../components/Logo';
import { InvitationStatusBadge } from '../components/StatusBadges';
import styles from './InvitationPage.module.css';

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

  // SSE: real-time updates for this invitation
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(`${API_BASE}/invitations/${token}/events`);

    es.addEventListener('invitation_updated', async () => {
      try {
        const inv = await api.getInvitation(token);
        setInvitation(inv);
        setConfirmingAction(null);
        if (inv.locale) setLocale(inv.locale);
      } catch { /* ignore */ }
    });

    return () => es.close();
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

  if (loading) return <CenteredPage><Text tone="muted">{t.loading}</Text></CenteredPage>;
  if (error) return <CenteredPage><div className={styles.narrow}><Alert tone="danger">{error}</Alert></div></CenteredPage>;
  if (!invitation) return <CenteredPage><Text tone="muted">{t.invitationNotFound}</Text></CenteredPage>;

  const dateStr = new Date(invitation.date + 'T00:00:00')
    .toLocaleDateString(getLocale() === 'nl' ? 'nl-NL' : 'en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const closedMessages: Record<string, string> = {
    expired: t.invitationExpiredMsg,
    invalidated: t.invitationInvalidatedMsg,
    admin_cancelled: t.invitationWithdrawnMsg,
  };
  const closedMessage = !actionDone ? closedMessages[invitation.status] : undefined;
  const needsDiscipline = disciplines.length > 1 && !selectedDiscipline;
  const disciplineName = invitation.status === 'confirmed'
    ? invitation.discipline_name
    : invitation.status === 'invited' && disciplines.length === 1 ? disciplines[0].name : null;

  const prompt = (tone: 'success' | 'danger', message: string, confirmButton: ReactNode) => (
    <Alert tone={tone} title={message}>
      <div className={`${styles.choice} ${styles.promptActions}`}>
        {confirmButton}
        <Button fullWidth onClick={() => setConfirmingAction(null)}>{t.goBack}</Button>
      </div>
    </Alert>
  );

  return (
    <CenteredPage>
      <Card className={styles.card}>
        <div className={styles.layout}>
          <Logo className={styles.logo} />
          <Stack gap={5} className={styles.content}>
            <h1 className={styles.title}>{t.trainingInvitation}</h1>

            <DescriptionList inline items={[
              { label: t.student, value: invitation.student_name },
              { label: t.date, value: dateStr },
              { label: t.time, value: <Text mono>{invitation.start_time}</Text> },
              {
                label: t.status,
                value: (
                  <Row gap={2} wrap>
                    <InvitationStatusBadge status={invitation.status} />
                    {invitation.status === 'invited' && invitation.expires_at && (
                      <Badge mono icon={<Timer />}><Countdown expiresAt={new Date(invitation.expires_at)} /></Badge>
                    )}
                  </Row>
                ),
              },
              ...(disciplineName ? [{ label: t.discipline, value: disciplineName }] : []),
            ]} />

            {actionDone === 'confirmed' && <Alert tone="success">{t.invitationConfirmedMsg}</Alert>}
            {actionDone === 'declined' && <Alert tone="info">{t.invitationDeclinedMsg}</Alert>}
            {actionDone === 'cancelled' && <Alert tone="info">{t.invitationCancelledMsg}</Alert>}
            {closedMessage && <Alert tone="danger">{closedMessage}</Alert>}

            {invitation.status === 'confirmed' && !actionDone && (
              <Stack gap={4}>
                <Alert tone="success">{t.invitationConfirmedMsg}</Alert>
                {confirmingAction === 'cancel'
                  ? prompt('danger', t.confirmPromptCancel, <Button variant="danger" fullWidth onClick={handleCancel}>{t.yesCancel}</Button>)
                  : <Button fullWidth icon={<X />} onClick={() => setConfirmingAction('cancel')}>{t.cancelParticipation}</Button>}
              </Stack>
            )}

            {invitation.status === 'invited' && !actionDone && (
              <Stack gap={4}>
                {disciplines.length > 1 && !confirmingAction && (
                  <Field label={t.chooseDiscipline} htmlFor="invitation-discipline">
                    <Select id="invitation-discipline" value={selectedDiscipline} onChange={e => setSelectedDiscipline(e.target.value)}>
                      <option value="" disabled>{t.selectDiscipline}</option>
                      {disciplines.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </Select>
                  </Field>
                )}
                {confirmingAction === 'confirm' ? (
                  prompt('success', t.confirmPromptConfirm, (
                    <Button variant="primary" fullWidth icon={<Check />} onClick={handleConfirm} disabled={needsDiscipline}>{t.yesConfirm}</Button>
                  ))
                ) : confirmingAction === 'decline' ? (
                  prompt('danger', t.confirmPromptDecline, (
                    <Button variant="danger" fullWidth onClick={handleDecline}>{t.yesDecline}</Button>
                  ))
                ) : (
                  <div className={styles.choice}>
                    <Button variant="primary" fullWidth icon={<Check />} onClick={() => setConfirmingAction('confirm')} disabled={needsDiscipline}>
                      {t.confirmAttendance}
                    </Button>
                    <Button fullWidth icon={<X />} onClick={() => setConfirmingAction('decline')}>{t.decline}</Button>
                  </div>
                )}
              </Stack>
            )}
          </Stack>
        </div>
      </Card>
    </CenteredPage>
  );
}

