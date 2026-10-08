import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Plus, Star } from 'lucide-react';
import { api } from '../api';
import {
  ActionMenu, Alert, Badge, Button, Dialog, EmptyState, Field, Input,
  Page, PageHeader, Row, Stack, Table, Text, useConfirm, useToast,
} from '../ui';
import { useT } from '../i18n';

interface Timetable {
  id: number;
  name: string;
  status: string;
  is_default: number;
  active: number;
  timeslot_count: number;
}

export default function TimetablesPage() {
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();

  const load = async () => {
    try {
      setTimetables(await api.getTimetables());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!name) return;
    setError('');
    try {
      const timetable = await api.createTimetable({ name });
      setShowModal(false);
      setName('');
      navigate(`/timetables/${timetable.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm({ title: t.delete, message: t.confirmDeleteTimetable, confirmLabel: t.delete, danger: true })) return;
    try {
      await api.deleteTimetable(id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleToggleActive = async (id: number) => {
    try {
      await api.toggleTimetableActive(id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleSetDefault = async (id: number) => {
    try {
      await api.setDefaultTimetable(id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;

  return (
    <Page>
      <PageHeader
        title={t.timetablesTitle(timetables.length)}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => { setError(''); setName(''); setShowModal(true); }}>
            {t.newTimetable}
          </Button>
        }
      />

      {timetables.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title={t.noTimetablesYet} description={t.noTimetablesHint} />
      ) : (
        <Table interactive>
          <thead>
            <tr>
              <th>{t.name}</th>
              <th>{t.status}</th>
              <th data-numeric>{t.timeslots}</th>
              <th>{t.active}</th>
              <th data-actions>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {timetables.map(tt => (
              <tr key={tt.id} onClick={() => navigate(`/timetables/${tt.id}`)}>
                <td>
                  <Row gap={2}>
                    <Text weight="medium">{tt.name}</Text>
                    {tt.is_default ? <Badge tone="accent" icon={<Star />}>{t.default}</Badge> : null}
                  </Row>
                </td>
                <td>
                  <Badge tone={tt.status === 'saved' ? 'success' : 'neutral'}>{t.statusMap(tt.status)}</Badge>
                </td>
                <td data-numeric>{tt.timeslot_count}</td>
                <td>
                  <Badge tone={tt.active ? 'success' : 'neutral'}>{tt.active ? t.active : t.inactive}</Badge>
                </td>
                <td data-actions>
                  <ActionMenu actions={[
                    { label: t.view, onClick: () => navigate(`/timetables/${tt.id}`) },
                    ...(tt.status === 'saved' && tt.active && !tt.is_default ? [{ label: t.setDefault, onClick: () => handleSetDefault(tt.id) }] : []),
                    { label: tt.active ? t.deactivate : t.activate, onClick: () => handleToggleActive(tt.id) },
                    { label: t.delete, onClick: () => handleDelete(tt.id), danger: true },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Dialog
        open={showModal}
        onOpenChange={setShowModal}
        title={t.newTimetableTitle}
        footer={
          <>
            <Button onClick={() => setShowModal(false)}>{t.cancel}</Button>
            <Button variant="primary" type="submit" form="new-timetable-form">{t.create}</Button>
          </>
        }
      >
        <form id="new-timetable-form" onSubmit={e => { e.preventDefault(); handleCreate(); }}>
          <Stack gap={4}>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label={t.name} htmlFor="timetable-name">
              <Input id="timetable-name" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t.timetableNamePlaceholder} required />
            </Field>
          </Stack>
        </form>
      </Dialog>
    </Page>
  );
}
