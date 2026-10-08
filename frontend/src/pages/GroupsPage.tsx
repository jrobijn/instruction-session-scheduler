import { useState, useEffect, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Star, Users } from 'lucide-react';
import { api } from '../api';
import {
  ActionMenu, Alert, Badge, Button, ColorInput, Dialog, EmptyState, Field, Input,
  Page, PageHeader, Row, SortHeader, Stack, Table, Text, useConfirm, useToast,
} from '../ui';
import { CsvActions, ImportResultAlert, type ImportResult } from '../components/CsvActions';
import { useT } from '../i18n';

interface Group {
  id: number;
  name: string;
  color: string;
  is_default: number;
  active: number;
  member_count: number;
  discipline_count: number;
}

export default function GroupsPage() {
  const navigate = useNavigate();
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [groups, setGroups] = useState<Group[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [form, setForm] = useState({ name: '', color: '#3b82f6' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [sortCol, setSortCol] = useState<keyof Group>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (col: keyof Group) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedGroups = [...groups].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortProps = (col: keyof Group) => ({ active: sortCol === col, direction: sortDir, onSort: () => toggleSort(col) });

  const load = async () => {
    try {
      setGroups(await api.getGroups());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', color: '#3b82f6' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (group: Group) => {
    setEditing(group);
    setForm({ name: group.name, color: group.color || '#3b82f6' });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        await api.updateGroup(editing.id, { name: form.name, color: form.color });
      } else {
        await api.createGroup({ name: form.name, color: form.color });
      }
      setShowModal(false);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (group: Group) => {
    if (!await confirm({ title: t.delete, message: t.confirmDeleteGroup(group.name), confirmLabel: t.delete, danger: true })) return;
    try {
      await api.deleteGroup(group.id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const toggleActive = async (group: Group) => {
    try {
      await api.updateGroup(group.id, { active: group.active ? 0 : 1 });
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleToggleDefault = async (group: Group) => {
    try {
      if (group.is_default) {
        await api.unsetDefaultGroup(group.id);
      } else {
        await api.setDefaultGroup(group.id);
      }
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;

  return (
    <Page>
      <PageHeader
        title={t.groupsTitle(groups.length)}
        actions={
          <>
            <CsvActions
              filename="groups.csv"
              exportCsv={api.exportGroupsCsv}
              importCsv={api.importGroupsCsv}
              onImported={result => { setImportResult(result); load(); }}
            />
            <Button variant="primary" icon={<Plus />} onClick={openCreate}>{t.addGroupButton}</Button>
          </>
        }
      />

      {importResult && <ImportResultAlert result={importResult} onDismiss={() => setImportResult(null)} />}

      {groups.length === 0 ? (
        <EmptyState icon={<Users />} title={t.noGroupsYet} description={t.noGroupsHint} />
      ) : (
        <Table interactive>
          <thead>
            <tr>
              <SortHeader {...sortProps('name')}>{t.name}</SortHeader>
              <th>{t.color}</th>
              <SortHeader numeric {...sortProps('member_count')}>{t.members}</SortHeader>
              <SortHeader numeric {...sortProps('discipline_count')}>{t.disciplinesSection}</SortHeader>
              <SortHeader {...sortProps('active')}>{t.status}</SortHeader>
              <th data-actions>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sortedGroups.map(g => (
              <tr key={g.id} onClick={() => navigate(`/groups/${g.id}`)}>
                <td>
                  <Row gap={2}>
                    <Text weight="medium">{g.name}</Text>
                    {g.is_default ? <Badge tone="accent" icon={<Star />}>{t.default}</Badge> : null}
                  </Row>
                </td>
                <td>
                  <ColorInput
                    aria-label={t.color}
                    value={g.color || '#3b82f6'}
                    onClick={e => e.stopPropagation()}
                    onChange={async e => {
                      try {
                        await api.updateGroup(g.id, { color: e.target.value });
                        load();
                      } catch { /* ignore */ }
                    }}
                  />
                </td>
                <td data-numeric>{g.member_count}</td>
                <td data-numeric>{g.discipline_count}</td>
                <td>
                  <Badge tone={g.active ? 'success' : 'neutral'}>{g.active ? t.active : t.inactive}</Badge>
                </td>
                <td data-actions>
                  <ActionMenu actions={[
                    { label: t.edit, onClick: () => openEdit(g) },
                    { label: g.is_default ? t.unsetDefault : t.setDefault, onClick: () => handleToggleDefault(g) },
                    { label: g.active ? t.deactivate : t.activate, onClick: () => toggleActive(g) },
                    { label: t.delete, onClick: () => handleDelete(g), danger: true },
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
        title={editing ? t.editGroup : t.addGroupTitle}
        footer={
          <>
            <Button onClick={() => setShowModal(false)}>{t.cancel}</Button>
            <Button variant="primary" type="submit" form="group-form">{editing ? t.save : t.addGroupTitle}</Button>
          </>
        }
      >
        <form id="group-form" onSubmit={handleSubmit}>
          <Stack gap={4}>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label={t.name} htmlFor="group-name">
              <Input id="group-name" autoFocus={!editing} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label={t.color} htmlFor="group-color">
              <ColorInput id="group-color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} />
            </Field>
          </Stack>
        </form>
      </Dialog>
    </Page>
  );
}
