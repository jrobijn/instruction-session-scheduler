import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowUpDown, Check, Plus, Save, Star, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';
import {
  Alert, Badge, Button, Card, Chip, Input, Page, PageHeader, Row, Select, Slider, Stack, Text,
  useConfirm, useToast,
} from '../ui';
import { AllocationBar } from '../components/AllocationBar';
import styles from './TimetableDetailPage.module.css';

interface Timeslot {
  id: number;
  timetable_id: number;
  start_time: string;
}

interface TimetableGroup {
  group_id: number;
  percentage: number;
  group_name: string;
  is_default: number;
  group_color: string;
}

interface AvailableGroup {
  id: number;
  name: string;
  is_default: number;
  active: number;
  color: string;
}

interface TimetableDetail {
  id: number;
  name: string;
  status: string;
  is_default: number;
  active: number;
  timeslots: Timeslot[];
  groups: TimetableGroup[];
}

export default function TimetableDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [timetable, setTimetable] = useState<TimetableDetail | null>(null);
  const [editName, setEditName] = useState('');
  const [newTimeslotTime, setNewTimeslotTime] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [allGroups, setAllGroups] = useState<AvailableGroup[]>([]);
  const [groupAssignments, setGroupAssignments] = useState<Array<{ group_id: number; percentage: number }>>([]);
  const [groupError, setGroupError] = useState('');
  const [reorderMode, setReorderMode] = useState(false);

  const load = async () => {
    try {
      const [data, groups] = await Promise.all([
        api.getTimetable(Number(id)),
        api.getGroups(),
      ]);
      setTimetable(data);
      setEditName(data.name);
      setAllGroups(groups.filter((g: AvailableGroup) => g.active));
      setGroupAssignments(data.groups.map((g: TimetableGroup) => ({ group_id: g.group_id, percentage: g.percentage })));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const updateName = async () => {
    if (!editName || editName === timetable?.name) return;
    try {
      await api.updateTimetable(Number(id), { name: editName });
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const addTimeslot = async () => {
    if (!newTimeslotTime) return;
    try {
      await api.addTimetableTimeslot(Number(id), newTimeslotTime);
      setNewTimeslotTime('');
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const deleteTimeslot = async (timeslotId: number) => {
    try {
      await api.deleteTimetableTimeslot(Number(id), timeslotId);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleSave = async () => {
    if (!await confirm({ title: t.saveTimetable, message: t.confirmSaveTimetable, confirmLabel: t.saveTimetable })) return;
    try {
      await api.saveTimetable(Number(id));
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleSetDefault = async () => {
    try {
      await api.setDefaultTimetable(Number(id));
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleToggleActive = async () => {
    try {
      await api.toggleTimetableActive(Number(id));
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleDelete = async () => {
    if (!await confirm({ title: t.delete, message: t.confirmDeleteTimetable, confirmLabel: t.delete, danger: true })) return;
    try {
      await api.deleteTimetable(Number(id));
      navigate('/timetables');
    } catch (err: any) {
      toast(err.message);
    }
  };

  const setAssignmentPercentage = (idx: number, newVal: number) => {
    const diff = newVal - groupAssignments[idx].percentage;
    if (diff === 0) return;
    const others = groupAssignments.filter((_, i) => i !== idx);
    const othersTotal = others.reduce((s, g) => s + g.percentage, 0);
    const next = groupAssignments.map((g, i) => {
      if (i === idx) return { ...g, percentage: newVal };
      if (othersTotal === 0) return { ...g, percentage: Math.floor((100 - newVal) / others.length) };
      // Distribute the diff proportionally among the others
      return { ...g, percentage: Math.max(0, Math.round(g.percentage - diff * (g.percentage / othersTotal))) };
    });
    // Fix rounding so the total is exactly 100
    const total = next.reduce((s, g) => s + g.percentage, 0);
    if (total !== 100 && next.length > 1) {
      const fixIdx = next.findIndex((_, i) => i !== idx);
      if (fixIdx >= 0) next[fixIdx] = { ...next[fixIdx], percentage: next[fixIdx].percentage + (100 - total) };
    }
    setGroupAssignments(next);
  };

  const removeAssignment = (idx: number) => {
    const freed = groupAssignments[idx].percentage;
    const remaining = groupAssignments.filter((_, i) => i !== idx);
    if (remaining.length === 0) { setGroupAssignments([]); return; }
    const remainingTotal = remaining.reduce((s, g) => s + g.percentage, 0);
    const next = remaining.map((g, i) => {
      if (remainingTotal === 0) {
        const share = Math.floor(100 / remaining.length);
        return { ...g, percentage: i === 0 ? share + (100 - share * remaining.length) : share };
      }
      return { ...g, percentage: Math.round(g.percentage + freed * (g.percentage / remainingTotal)) };
    });
    const total = next.reduce((s, g) => s + g.percentage, 0);
    if (total !== 100 && next.length > 0) next[0] = { ...next[0], percentage: next[0].percentage + (100 - total) };
    setGroupAssignments(next);
  };

  const addAssignment = (gid: number) => {
    const newShare = Math.floor(100 / (groupAssignments.length + 1));
    const oldTotal = 100 - newShare;
    const currentTotal = groupAssignments.reduce((s, g) => s + g.percentage, 0);
    const next = groupAssignments.map(g => ({
      ...g,
      percentage: currentTotal > 0
        ? Math.round(g.percentage * oldTotal / currentTotal)
        : Math.floor(oldTotal / groupAssignments.length),
    }));
    next.push({ group_id: gid, percentage: 100 - next.reduce((s, g) => s + g.percentage, 0) });
    setGroupAssignments(next);
  };

  const saveAssignments = async () => {
    setGroupError('');
    if (groupAssignments.length === 0) { setGroupError(t.atLeastOneGroup); return; }
    try {
      await api.setTimetableGroups(Number(id), groupAssignments);
      load();
    } catch (err: any) {
      setGroupError(err.message);
    }
  };

  const saveGroupOrder = async () => {
    if (!timetable) return;
    try {
      await api.reorderTimetableGroups(Number(id), timetable.groups.map(g => g.group_id));
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;
  if (!timetable) return <Page><Text tone="muted">{t.timetableNotFound}</Text></Page>;

  const isDraft = timetable.status === 'draft';

  // Fallback palette for groups without a colour (data colours, not theme colours)
  const GROUP_COLORS_FALLBACK = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'];

  const barSegments = isDraft
    ? groupAssignments.map((ga, idx) => {
        const group = allGroups.find(g => g.id === ga.group_id);
        return { name: group?.name || `Group ${ga.group_id}`, percentage: ga.percentage, color: group?.color || GROUP_COLORS_FALLBACK[idx % GROUP_COLORS_FALLBACK.length] };
      })
    : timetable.groups.map((g, idx) => ({
        name: g.group_name,
        percentage: g.percentage,
        color: g.group_color || GROUP_COLORS_FALLBACK[idx % GROUP_COLORS_FALLBACK.length],
      }));

  const assignedIds = new Set(groupAssignments.map(ga => ga.group_id));
  const availableGroups = allGroups.filter(g => !assignedIds.has(g.id));

  return (
    <Page>
      <PageHeader
        back={{ label: t.backToTimetables, onClick: () => navigate('/timetables') }}
        title={timetable.name}
        meta={
          <>
            <Badge tone={timetable.status === 'saved' ? 'success' : 'neutral'}>{t.statusMap(timetable.status)}</Badge>
            <Badge tone={timetable.active ? 'success' : 'neutral'}>{timetable.active ? t.active : t.inactive}</Badge>
            {timetable.is_default ? <Badge tone="accent" icon={<Star />}>{t.default}</Badge> : null}
          </>
        }
        actions={
          <>
            {timetable.status === 'saved' && timetable.active && !timetable.is_default && (
              <Button icon={<Star />} onClick={handleSetDefault}>{t.setAsDefault}</Button>
            )}
            <Button onClick={handleToggleActive}>{timetable.active ? t.deactivate : t.activate}</Button>
            <Button variant="ghost" icon={<Trash2 />} onClick={handleDelete}>{t.delete}</Button>
            {isDraft && timetable.timeslots.length > 0 && (
              <Button variant="primary" icon={<Save />} onClick={handleSave}>{t.saveTimetable}</Button>
            )}
          </>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {isDraft && <Alert tone="info">{t.saveTimetableHint}</Alert>}

      {isDraft && (
        <Card title={t.name}>
          <Row gap={2}>
            <Input aria-label={t.name} value={editName} onChange={e => setEditName(e.target.value)} />
            <Button onClick={updateName} disabled={editName === timetable.name || !editName}>{t.updateName}</Button>
          </Row>
        </Card>
      )}

      <Card
        title={t.timeslotsCount(timetable.timeslots.length)}
        actions={isDraft && (
          <form className={styles.addTimeslot} onSubmit={e => { e.preventDefault(); addTimeslot(); }}>
            <Input type="time" aria-label={t.addTimeslot} value={newTimeslotTime} onChange={e => setNewTimeslotTime(e.target.value)} />
            <Button type="submit" size="sm" icon={<Plus />} disabled={!newTimeslotTime}>{t.addTimeslot}</Button>
          </form>
        )}
      >
        {timetable.timeslots.length === 0 ? (
          <Text tone="muted">{t.noTimeslotsDefined}</Text>
        ) : (
          <Row gap={2} wrap>
            {timetable.timeslots.map(ts => (
              <Chip key={ts.id} mono onRemove={isDraft ? () => deleteTimeslot(ts.id) : undefined} removeLabel={t.remove}>
                {ts.start_time}
              </Chip>
            ))}
          </Row>
        )}
      </Card>

      <Card
        title={t.groupAllocations}
        actions={isDraft
          ? <Button size="sm" icon={<Save />} onClick={saveAssignments}>{t.saveGroupAllocations}</Button>
          : timetable.groups.length > 1 && (
            <Button
              size="sm"
              variant={reorderMode ? 'primary' : 'secondary'}
              icon={reorderMode ? <Check /> : <ArrowUpDown />}
              onClick={() => {
                if (reorderMode) saveGroupOrder();
                setReorderMode(!reorderMode);
              }}
            >
              {reorderMode ? t.doneReordering : t.reorderGroups}
            </Button>
          )}
      >
        {isDraft ? (
          <Stack gap={4}>
            {groupAssignments.length > 0 && (
              <Stack gap={1}>
                {groupAssignments.map((ga, idx) => {
                  const group = allGroups.find(g => g.id === ga.group_id);
                  const name = group?.name || `Group ${ga.group_id}`;
                  return (
                    <div key={ga.group_id} className={styles.allocationRow}>
                      <Row gap={2}>
                        <span className={styles.swatch} style={{ background: barSegments[idx]?.color }} />
                        <Text weight="medium">{name}</Text>
                      </Row>
                      <Slider aria-label={name} value={ga.percentage} onValueChange={v => setAssignmentPercentage(idx, v)} />
                      <Text mono weight="medium">{ga.percentage}%</Text>
                      <Button variant="ghost" size="sm" icon={<X />} aria-label={t.remove} onClick={() => removeAssignment(idx)} />
                    </div>
                  );
                })}
              </Stack>
            )}
            {availableGroups.length > 0 && (
              <div className={styles.addGroup}>
                <Select
                  aria-label={t.addGroupSelect}
                  value=""
                  onChange={e => { if (Number(e.target.value)) addAssignment(Number(e.target.value)); }}
                >
                  <option value="">{t.addGroupSelect}</option>
                  {availableGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </Select>
              </div>
            )}
            {groupError && <Alert tone="danger">{groupError}</Alert>}
            <AllocationBar
              segments={barSegments}
              draggable
              onReorder={(from, to) => {
                const next = [...groupAssignments];
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved);
                setGroupAssignments(next);
              }}
            />
          </Stack>
        ) : timetable.groups.length === 0 ? (
          <Text tone="muted">{t.noGroupsAssignedTimetable}</Text>
        ) : (
          <AllocationBar
            segments={barSegments}
            draggable={reorderMode}
            onReorder={(from, to) => {
              const next = [...timetable.groups];
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              setTimetable({ ...timetable, groups: next });
            }}
          />
        )}
      </Card>
    </Page>
  );
}
