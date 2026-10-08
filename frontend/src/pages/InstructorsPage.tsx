import { Fragment, useState, useEffect, FormEvent } from 'react';
import { Plus, UserRound } from 'lucide-react';
import { api } from '../api';
import {
  ActionMenu, Alert, Badge, Button, DescriptionList, Dialog, EmptyState, ExpandIcon, Field, Input,
  Page, PageHeader, Row, SortHeader, Stack, Table, Text, useConfirm, useToast,
} from '../ui';
import { CsvActions, ImportResultAlert, type ImportResult } from '../components/CsvActions';
import { useT } from '../i18n';

interface Instructor {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  active: number;
}

export default function InstructorsPage() {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [instructors, setInstructors] = useState<Instructor[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Instructor | null>(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [expandedInstructor, setExpandedInstructor] = useState<number | null>(null);
  const [sortCol, setSortCol] = useState<keyof Instructor>('last_name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (col: keyof Instructor) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedInstructors = [...instructors].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortProps = (col: keyof Instructor) => ({ active: sortCol === col, direction: sortDir, onSort: () => toggleSort(col) });

  const load = async () => {
    try {
      setInstructors(await api.getInstructors());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ first_name: '', last_name: '', email: '' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (instructor: Instructor) => {
    setEditing(instructor);
    setForm({ first_name: instructor.first_name, last_name: instructor.last_name, email: instructor.email });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        await api.updateInstructor(editing.id, form);
      } else {
        await api.createInstructor(form);
      }
      setShowModal(false);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm({ title: t.delete, message: t.confirmDeleteInstructor, confirmLabel: t.delete, danger: true })) return;
    try {
      await api.deleteInstructor(id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const toggleActive = async (instructor: Instructor) => {
    try {
      await api.updateInstructor(instructor.id, { active: instructor.active ? 0 : 1 });
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;

  return (
    <Page>
      <PageHeader
        title={t.instructorsTitle(instructors.length)}
        actions={
          <>
            <CsvActions
              filename="instructors.csv"
              exportCsv={api.exportInstructorsCsv}
              importCsv={api.importInstructorsCsv}
              onImported={result => { setImportResult(result); load(); }}
            />
            <Button variant="primary" icon={<Plus />} onClick={openCreate}>{t.addInstructor}</Button>
          </>
        }
      />

      {importResult && <ImportResultAlert result={importResult} onDismiss={() => setImportResult(null)} />}

      {instructors.length === 0 ? (
        <EmptyState icon={<UserRound />} title={t.noInstructorsYet} description={t.noInstructorsHint} />
      ) : (
        <Table interactive>
          <thead>
            <tr>
              <SortHeader {...sortProps('last_name')}>{t.name}</SortHeader>
              <SortHeader {...sortProps('active')}>{t.status}</SortHeader>
              <th data-actions>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sortedInstructors.map(i => {
              const isExpanded = expandedInstructor === i.id;
              return (
                <Fragment key={i.id}>
                  <tr data-expanded={isExpanded || undefined} onClick={() => setExpandedInstructor(isExpanded ? null : i.id)}>
                    <td>
                      <Row gap={2}>
                        <ExpandIcon expanded={isExpanded} />
                        <Text weight="medium">{i.first_name} {i.last_name}</Text>
                      </Row>
                    </td>
                    <td>
                      <Badge tone={i.active ? 'success' : 'neutral'}>{i.active ? t.active : t.inactive}</Badge>
                    </td>
                    <td data-actions>
                      <ActionMenu actions={[
                        { label: t.edit, onClick: () => openEdit(i) },
                        { label: i.active ? t.deactivate : t.activate, onClick: () => toggleActive(i) },
                        { label: t.delete, onClick: () => handleDelete(i.id), danger: true },
                      ]} />
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr data-detail>
                      <td colSpan={3}>
                        <DescriptionList items={[
                          { label: t.firstName, value: i.first_name },
                          { label: t.lastName, value: i.last_name },
                          { label: t.email, value: i.email },
                        ]} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      )}

      <Dialog
        open={showModal}
        onOpenChange={setShowModal}
        title={editing ? t.editInstructor : t.addInstructorTitle}
        footer={
          <>
            <Button onClick={() => setShowModal(false)}>{t.cancel}</Button>
            <Button variant="primary" type="submit" form="instructor-form">{editing ? t.save : t.addInstructorTitle}</Button>
          </>
        }
      >
        <form id="instructor-form" onSubmit={handleSubmit}>
          <Stack gap={4}>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label={t.firstName} htmlFor="instructor-first-name">
              <Input id="instructor-first-name" autoFocus={!editing} value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })} required />
            </Field>
            <Field label={t.lastName} htmlFor="instructor-last-name">
              <Input id="instructor-last-name" value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })} required />
            </Field>
            <Field label={t.email} htmlFor="instructor-email">
              <Input id="instructor-email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
            </Field>
          </Stack>
        </form>
      </Dialog>
    </Page>
  );
}
