import { useState, useEffect, FormEvent } from 'react';
import { Plus, Target } from 'lucide-react';
import { api } from '../api';
import {
  ActionMenu, Alert, Badge, Button, Dialog, EmptyState, Field, Input,
  Page, PageHeader, SortHeader, Stack, Table, Text, useConfirm, useToast,
} from '../ui';
import { CsvActions, ImportResultAlert, type ImportResult } from '../components/CsvActions';
import { useT } from '../i18n';

interface Discipline {
  id: number;
  name: string;
  abbreviation: string;
  active: number;
}

export default function DisciplinesPage() {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Discipline | null>(null);
  const [form, setForm] = useState({ name: '', abbreviation: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [sortCol, setSortCol] = useState<keyof Discipline>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (col: keyof Discipline) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedDisciplines = [...disciplines].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortProps = (col: keyof Discipline) => ({ active: sortCol === col, direction: sortDir, onSort: () => toggleSort(col) });

  const load = async () => {
    try {
      setDisciplines(await api.getDisciplines());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', abbreviation: '' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (discipline: Discipline) => {
    setEditing(discipline);
    setForm({ name: discipline.name, abbreviation: discipline.abbreviation || '' });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        await api.updateDiscipline(editing.id, form);
      } else {
        await api.createDiscipline(form);
      }
      setShowModal(false);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm({ title: t.delete, message: t.confirmDeleteDiscipline, confirmLabel: t.delete, danger: true })) return;
    try {
      await api.deleteDiscipline(id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const toggleActive = async (discipline: Discipline) => {
    try {
      await api.updateDiscipline(discipline.id, { active: discipline.active ? 0 : 1 });
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;

  return (
    <Page>
      <PageHeader
        title={t.disciplinesTitle(disciplines.length)}
        actions={
          <>
            <CsvActions
              filename="disciplines.csv"
              exportCsv={api.exportDisciplinesCsv}
              importCsv={api.importDisciplinesCsv}
              onImported={result => { setImportResult(result); load(); }}
            />
            <Button variant="primary" icon={<Plus />} onClick={openCreate}>{t.addDiscipline}</Button>
          </>
        }
      />

      {importResult && <ImportResultAlert result={importResult} onDismiss={() => setImportResult(null)} />}

      {disciplines.length === 0 ? (
        <EmptyState icon={<Target />} title={t.noDisciplinesYet} description={t.noDisciplinesHint} />
      ) : (
        <Table>
          <thead>
            <tr>
              <SortHeader {...sortProps('name')}>{t.name}</SortHeader>
              <th>{t.abbreviation}</th>
              <SortHeader {...sortProps('active')}>{t.status}</SortHeader>
              <th data-actions>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sortedDisciplines.map(d => (
              <tr key={d.id}>
                <td><Text weight="medium">{d.name}</Text></td>
                <td><Text mono tone="muted">{d.abbreviation}</Text></td>
                <td>
                  <Badge tone={d.active ? 'success' : 'neutral'}>{d.active ? t.active : t.inactive}</Badge>
                </td>
                <td data-actions>
                  <ActionMenu actions={[
                    { label: t.edit, onClick: () => openEdit(d) },
                    { label: d.active ? t.deactivate : t.activate, onClick: () => toggleActive(d) },
                    { label: t.delete, onClick: () => handleDelete(d.id), danger: true },
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
        title={editing ? t.editDiscipline : t.addDisciplineTitle}
        footer={
          <>
            <Button onClick={() => setShowModal(false)}>{t.cancel}</Button>
            <Button variant="primary" type="submit" form="discipline-form">{editing ? t.save : t.addDisciplineTitle}</Button>
          </>
        }
      >
        <form id="discipline-form" onSubmit={handleSubmit}>
          <Stack gap={4}>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label={t.name} htmlFor="discipline-name">
              <Input id="discipline-name" autoFocus={!editing} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label={t.abbreviation} htmlFor="discipline-abbreviation">
              <Input id="discipline-abbreviation" value={form.abbreviation} onChange={e => setForm({ ...form, abbreviation: e.target.value })} />
            </Field>
          </Stack>
        </form>
      </Dialog>
    </Page>
  );
}
