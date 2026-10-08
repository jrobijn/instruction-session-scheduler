import { Fragment, useState, useEffect, FormEvent, type CSSProperties } from 'react';
import { GraduationCap, Layers, Mail, Plus, Timer, Users, UsersRound, X } from 'lucide-react';
import { api } from '../api';
import {
  ActionMenu, Alert, Badge, Button, Checkbox, DescriptionList, Dialog, EmptyState, ExpandIcon, Field, Input,
  Page, PageHeader, Row, SortHeader, Stack, Table, Text, Tooltip, useConfirm, useToast,
} from '../ui';
import { CsvActions, ImportResultAlert, type ImportResult } from '../components/CsvActions';
import { GroupLabel, InvitationStatusBadge } from '../components/StatusBadges';
import { useT, getLocale } from '../i18n';
import styles from './StudentsPage.module.css';
import buddyStyles from '../components/BuddyRows.module.css';

interface Student {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  membership_id: string;
  attended_sessions: number;
  no_show_count: number;
  preferred_days: string;
  active: number;
  cooldown_until: string | null;
  group?: { id: number; name: string; color: string | null } | null;
  buddy_group?: { id: number; name: string } | null;
}

interface Timetable {
  id: number;
  name: string;
  status: string;
  active: number;
  timeslots?: Array<{ id: number; start_time: string }>;
}

interface InvitationHistoryEntry {
  id: number;
  status: string;
  invited_at: string;
  responded_at: string | null;
  session_date: string;
  start_time: string;
  discipline_name: string | null;
  group_name: string | null;
  group_color: string | null;
}


export default function StudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [clubDays, setClubDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Student | null>(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', membership_id: '', preferred_days: '0|1|2|3|4|5|6' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [timeslotPrefs, setTimeslotPrefs] = useState<Record<number, number[]>>({});
  const [sortCol, setSortCol] = useState<keyof Student>('last_name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [cooldownModal, setCooldownModal] = useState<Student | null>(null);
  const [cooldownDays, setCooldownDays] = useState(7);
  const [expandedStudent, setExpandedStudent] = useState<number | null>(null);
  const [detailTimetables, setDetailTimetables] = useState<Timetable[]>([]);
  const [detailTimeslotPrefs, setDetailTimeslotPrefs] = useState<Record<number, number[]>>({});
  const [historyModal, setHistoryModal] = useState<Student | null>(null);
  const [historyEntries, setHistoryEntries] = useState<InvitationHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [buddyMode, setBuddyMode] = useState(false);
  const [buddySelection, setBuddySelection] = useState<Set<number>>(new Set());
  const [groupBuddies, setGroupBuddies] = useState(() => localStorage.getItem('groupBuddies') !== 'false');
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();

  const toggleGroupBuddies = () => {
    setGroupBuddies(prev => {
      const next = !prev;
      localStorage.setItem('groupBuddies', String(next));
      return next;
    });
  };

  const toggleSort = (col: keyof Student) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedStudents = (() => {
    const base = [...students].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    // Group buddy members together: place them after the first buddy in sort order
    if (!groupBuddies) return base;
    const placed = new Set<number>();
    const result: Student[] = [];
    for (const s of base) {
      if (placed.has(s.id)) continue;
      result.push(s);
      placed.add(s.id);
      if (s.buddy_group) {
        const buddies = base.filter(b => b.id !== s.id && !placed.has(b.id) && b.buddy_group?.id === s.buddy_group!.id);
        for (const b of buddies) {
          result.push(b);
          placed.add(b.id);
        }
      }
    }
    return result;
  })();

  // Distinct data colours per buddy group
  const BUDDY_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#c026d3', '#ea580c', '#4f46e5', '#059669'];
  const buddyColorMap = new Map<number, string>();
  const seenBuddyIds = [...new Set(sortedStudents.map(s => s.buddy_group?.id).filter(Boolean))] as number[];
  seenBuddyIds.forEach((bgId, i) => buddyColorMap.set(bgId, BUDDY_COLORS[i % BUDDY_COLORS.length]));

  const sortProps = (col: keyof Student) => ({ active: sortCol === col, direction: sortDir, onSort: () => toggleSort(col) });

  const formatInvitedAt = (value: string) => {
    const d = new Date(value.includes('Z') || value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
    const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
    return d.toLocaleString(dateLocale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const openHistory = async (student: Student) => {
    setHistoryModal(student);
    setHistoryEntries([]);
    setHistoryLoading(true);
    try {
      const history = await api.getStudentInvitationHistory(student.id);
      setHistoryEntries(history);
    } catch {
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const load = async () => {
    try {
      const [studentsData, settingsData] = await Promise.all([api.getStudents(), api.getSettings()]);
      setStudents(studentsData);
      const cd = (settingsData.club_days || '0|1|2|3|4|5|6').split('|').map(Number);
      setClubDays(cd);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const loadTimetables = async () => {
    try {
      const allTimetables = await api.getTimetables();
      const active = allTimetables.filter((t: Timetable) => t.active && t.status === 'saved');
      // Load timeslots for each active timetable
      const withTimeslots = await Promise.all(active.map(async (t: Timetable) => {
        const detail = await api.getTimetable(t.id);
        return { ...t, timeslots: detail.timeslots };
      }));
      setTimetables(withTimeslots);
    } catch { /* ignore */ }
  };

  const openCreate = async () => {
    setEditing(null);
    setForm({ first_name: '', last_name: '', email: '', membership_id: '', preferred_days: '0|1|2|3|4|5|6' });
    setTimeslotPrefs({});
    setError('');
    await loadTimetables();
    setShowModal(true);
  };

  const openEdit = async (student: Student) => {
    setEditing(student);
    setForm({ first_name: student.first_name, last_name: student.last_name, email: student.email, membership_id: student.membership_id || '', preferred_days: student.preferred_days });
    setError('');
    await loadTimetables();
    try {
      const prefs = await api.getStudentPreferredTimeslots(student.id);
      setTimeslotPrefs(prefs);
    } catch {
      setTimeslotPrefs({});
    }
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      let studentId: number;
      if (editing) {
        await api.updateStudent(editing.id, form);
        studentId = editing.id;
      } else {
        const created = await api.createStudent(form);
        studentId = created.id;
      }
      // Save timeslot preferences for each timetable
      for (const tt of timetables) {
        const tsIds = timeslotPrefs[tt.id] ?? (tt.timeslots || []).map((s: any) => s.id);
        await api.setStudentPreferredTimeslots(studentId, tt.id, tsIds);
      }
      setShowModal(false);
      load();
      // Refresh detail prefs if the edited student is currently expanded
      if (expandedStudent === studentId) {
        try {
          const prefs = await api.getStudentPreferredTimeslots(studentId);
          setDetailTimeslotPrefs(prefs);
        } catch { setDetailTimeslotPrefs({}); }
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm({ title: t.delete, message: t.confirmDeleteStudent, confirmLabel: t.delete, danger: true })) return;
    try {
      await api.deleteStudent(id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const toggleActive = async (student: Student) => {
    try {
      await api.updateStudent(student.id, { active: student.active ? 0 : 1 });
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const hasActiveCooldown = (s: Student) => s.cooldown_until && new Date(s.cooldown_until + 'Z') > new Date();

  const getCooldownInfo = (s: Student) => {
    if (!hasActiveCooldown(s)) return null;
    const until = new Date(s.cooldown_until + 'Z');
    const days = Math.ceil((until.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
    return { days, date: until.toLocaleDateString(dateLocale) };
  };

  const handleSetCooldown = async () => {
    if (!cooldownModal) return;
    try {
      await api.setStudentCooldown(cooldownModal.id, cooldownDays);
      setCooldownModal(null);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleClearCooldown = async (s: Student) => {
    if (!await confirm({ title: t.cooldown, message: t.confirmRemoveCooldown(`${s.first_name} ${s.last_name}`) })) return;
    try {
      await api.clearStudentCooldown(s.id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const toggleBuddyMode = () => {
    setBuddyMode(!buddyMode);
    setBuddySelection(new Set());
  };

  const toggleBuddySelect = (id: number) => {
    setBuddySelection(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGroupSelected = async () => {
    const ids = Array.from(buddySelection);
    if (ids.length < 2) return;
    try {
      await api.quickCreateBuddyGroup(ids);
      setBuddySelection(new Set());
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleUngroupBuddy = async (groupId: number) => {
    if (!await confirm({ title: t.ungroup, message: t.confirmDissolveBuddyGroup, confirmLabel: t.ungroup, danger: true })) return;
    try {
      await api.deleteBuddyGroup(groupId);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleRemoveFromBuddy = async (student: Student) => {
    if (!student.buddy_group) return;
    try {
      await api.removeBuddyGroupMember(student.buddy_group.id, student.id);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const toggleExpanded = async (s: Student) => {
    if (expandedStudent === s.id) { setExpandedStudent(null); return; }
    setExpandedStudent(s.id);
    try {
      const allTt = await api.getTimetables();
      const active = allTt.filter((tt: Timetable) => tt.active && tt.status === 'saved');
      const withTs = await Promise.all(active.map(async (tt: Timetable) => {
        const detail = await api.getTimetable(tt.id);
        return { ...tt, timeslots: detail.timeslots };
      }));
      setDetailTimetables(withTs);
      setDetailTimeslotPrefs(await api.getStudentPreferredTimeslots(s.id));
    } catch { setDetailTimetables([]); setDetailTimeslotPrefs({}); }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;

  const columnCount = buddyMode ? 7 : 6;
  const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
  const groupBuddiesLabel = groupBuddies ? t.groupBuddiesOn : t.groupBuddiesOff;

  return (
    <Page>
      <PageHeader
        title={t.studentsTitle(students.length)}
        actions={
          <>
            <div className={styles.segmented}>
              <Button variant={buddyMode ? 'primary' : 'secondary'} icon={<UsersRound />} onClick={toggleBuddyMode}>
                {buddyMode ? t.finishBuddyMode : t.manageBuddies}
              </Button>
              <Tooltip content={groupBuddiesLabel}>
                <Button icon={<Layers />} aria-label={groupBuddiesLabel} pressed={groupBuddies} onClick={toggleGroupBuddies} />
              </Tooltip>
            </div>
            <CsvActions
              filename="students.csv"
              exportCsv={api.exportStudentsCsv}
              importCsv={api.importStudentsCsv}
              onImported={result => { setImportResult(result); load(); }}
              disabled={buddyMode}
            />
            <Button variant="primary" icon={<Plus />} onClick={openCreate} disabled={buddyMode}>{t.addStudent}</Button>
          </>
        }
      />

      {buddyMode && (
        <Alert
          tone="info"
          action={buddySelection.size >= 2 && (
            <Button variant="primary" size="sm" icon={<Users />} onClick={handleGroupSelected}>
              {t.groupSelected(buddySelection.size)}
            </Button>
          )}
        >
          {t.buddyModeHint}
        </Alert>
      )}

      {importResult && <ImportResultAlert result={importResult} onDismiss={() => setImportResult(null)} />}

      {students.length === 0 ? (
        <EmptyState icon={<GraduationCap />} title={t.noStudentsYet} description={t.noStudentsHint} />
      ) : (
        <Table interactive>
          <thead>
            <tr>
              {buddyMode && <th className={styles.selectCol} />}
              <SortHeader {...sortProps('last_name')}>{t.name}</SortHeader>
              <SortHeader {...sortProps('membership_id')}>{t.membershipId}</SortHeader>
              <SortHeader numeric {...sortProps('attended_sessions')}>{t.sessionsAttended}</SortHeader>
              <SortHeader numeric {...sortProps('no_show_count')}>{t.noShows}</SortHeader>
              <SortHeader {...sortProps('active')}>{t.status}</SortHeader>
              <th data-actions>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sortedStudents.map((s, idx) => {
              const cooldownInfo = getCooldownInfo(s);
              const isExpanded = expandedStudent === s.id;
              const buddyId = s.buddy_group?.id;
              const isFirstInBuddy = !!buddyId && (idx === 0 || sortedStudents[idx - 1].buddy_group?.id !== buddyId);
              const isLastInBuddy = !!buddyId && (idx === sortedStudents.length - 1 || sortedStudents[idx + 1].buddy_group?.id !== buddyId);
              const fullName = `${s.first_name} ${s.last_name}`;
              const preferredDays = s.preferred_days
                ? s.preferred_days.split('|').filter(d => clubDays.includes(Number(d))).map(d => t.days[Number(d)]).join(', ') || t.noData
                : t.noData;
              return (
                <Fragment key={s.id}>
                  <tr
                    className={buddyId ? buddyStyles.buddyRow : undefined}
                    style={buddyId ? { '--buddy': buddyColorMap.get(buddyId) } as CSSProperties : undefined}
                    data-first={isFirstInBuddy || undefined}
                    data-last={isLastInBuddy || undefined}
                    data-expanded={isExpanded || undefined}
                    onClick={() => {
                      if (buddyMode) { if (!s.buddy_group) toggleBuddySelect(s.id); return; }
                      toggleExpanded(s);
                    }}
                  >
                    {buddyMode && (
                      <td onClick={e => e.stopPropagation()}>
                        {!s.buddy_group && (
                          <Checkbox aria-label={fullName} checked={buddySelection.has(s.id)} onCheckedChange={() => toggleBuddySelect(s.id)} />
                        )}
                      </td>
                    )}
                    <td>
                      <Row gap={2}>
                        {!buddyMode && <ExpandIcon expanded={isExpanded} />}
                        <Text weight="medium">{fullName}</Text>
                        {s.buddy_group && (
                          <Tooltip content={s.buddy_group.name}>
                            <span className={buddyStyles.buddyIcon}><Users /></span>
                          </Tooltip>
                        )}
                        {buddyMode && s.buddy_group && (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<X />}
                            aria-label={t.removeFromBuddyGroup}
                            onClick={e => { e.stopPropagation(); handleRemoveFromBuddy(s); }}
                          />
                        )}
                        {buddyMode && isFirstInBuddy && s.buddy_group && (
                          <Button size="sm" onClick={e => { e.stopPropagation(); handleUngroupBuddy(s.buddy_group!.id); }}>{t.ungroup}</Button>
                        )}
                      </Row>
                    </td>
                    <td><Text mono tone="muted">{s.membership_id}</Text></td>
                    <td data-numeric>{s.attended_sessions}</td>
                    <td data-numeric>{s.no_show_count}</td>
                    <td>
                      <Badge tone={s.active ? 'success' : 'neutral'}>{s.active ? t.active : t.inactive}</Badge>
                    </td>
                    <td data-actions>
                      <Row gap={1} justify="end">
                        {cooldownInfo ? (
                          <Tooltip content={t.cooldownTooltip(cooldownInfo.days)}>
                            <Button
                              variant="danger"
                              size="sm"
                              icon={<Timer />}
                              aria-label={t.cooldownTooltip(cooldownInfo.days)}
                              onClick={e => { e.stopPropagation(); handleClearCooldown(s); }}
                            />
                          </Tooltip>
                        ) : (
                          <Tooltip content={t.setCooldown}>
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={<Timer />}
                              aria-label={t.setCooldown}
                              onClick={e => { e.stopPropagation(); setCooldownModal(s); setCooldownDays(7); }}
                            />
                          </Tooltip>
                        )}
                        <Tooltip content={t.invitationHistory}>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Mail />}
                            aria-label={t.invitationHistory}
                            onClick={e => { e.stopPropagation(); openHistory(s); }}
                          />
                        </Tooltip>
                        <ActionMenu actions={[
                          { label: t.edit, onClick: () => openEdit(s) },
                          { label: s.active ? t.deactivate : t.activate, onClick: () => toggleActive(s) },
                          { label: t.delete, onClick: () => handleDelete(s.id), danger: true },
                        ]} />
                      </Row>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr data-detail>
                      <td colSpan={columnCount}>
                        <DescriptionList items={[
                          { label: t.firstName, value: s.first_name },
                          { label: t.lastName, value: s.last_name },
                          { label: t.email, value: s.email },
                          { label: t.membershipId, value: s.membership_id ? <Text mono>{s.membership_id}</Text> : t.noData },
                          { label: t.sessionsAttended, value: <Text mono>{s.attended_sessions}</Text> },
                          { label: t.noShows, value: <Text mono>{s.no_show_count}</Text> },
                          { label: t.preferredDays, value: preferredDays },
                          ...(detailTimetables.length > 0 ? [{
                            label: t.preferredTimeslots,
                            value: (
                              <Stack gap={1}>
                                {detailTimetables.map(tt => {
                                  const prefIds = detailTimeslotPrefs[tt.id];
                                  const display = prefIds && prefIds.length > 0
                                    ? (tt.timeslots || []).filter(sl => prefIds.includes(sl.id)).map(sl => sl.start_time.slice(0, 5)).join(', ')
                                    : null;
                                  return (
                                    <span key={tt.id}>
                                      <Text tone="muted">{tt.name}: </Text>
                                      {display ? <Text mono>{display}</Text> : t.noData}
                                    </span>
                                  );
                                })}
                              </Stack>
                            ),
                          }] : []),
                          { label: t.group, value: s.group ? <GroupLabel name={s.group.name} color={s.group.color} /> : t.noData },
                          ...(cooldownInfo ? [{
                            label: t.cooldown,
                            value: <Text tone="danger">{t.cooldownDetail(cooldownInfo.days, cooldownInfo.date)}</Text>,
                          }] : []),
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
        title={editing ? t.editStudent : t.addStudentTitle}
        footer={
          <>
            <Button onClick={() => setShowModal(false)}>{t.cancel}</Button>
            <Button variant="primary" type="submit" form="student-form">{editing ? t.save : t.addStudentTitle}</Button>
          </>
        }
      >
        <form id="student-form" onSubmit={handleSubmit}>
          <Stack gap={4}>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className={styles.formRow}>
              <Field label={t.firstName} htmlFor="student-first-name">
                <Input id="student-first-name" autoFocus={!editing} value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })} required />
              </Field>
              <Field label={t.lastName} htmlFor="student-last-name">
                <Input id="student-last-name" value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })} required />
              </Field>
            </div>
            <Field label={t.email} htmlFor="student-email">
              <Input id="student-email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
            </Field>
            <Field label={t.membershipId} htmlFor="student-membership">
              <Input id="student-membership" value={form.membership_id} onChange={e => setForm({ ...form, membership_id: e.target.value })} />
            </Field>
            <Field label={t.preferredDays}>
              <Row gap={4} wrap>
                {[0, 1, 2, 3, 4, 5, 6].map(idx => {
                  const days = form.preferred_days ? form.preferred_days.split('|').filter(Boolean) : [];
                  const checked = days.includes(String(idx));
                  return (
                    <Checkbox
                      key={idx}
                      label={t.days[idx]}
                      checked={checked}
                      disabled={!clubDays.includes(idx)}
                      onCheckedChange={() => {
                        const newDays = checked ? days.filter(d => d !== String(idx)) : [...days, String(idx)].sort();
                        setForm({ ...form, preferred_days: newDays.join('|') });
                      }}
                    />
                  );
                })}
              </Row>
            </Field>
            {timetables.length > 0 && (
              <Field label={t.preferredTimeslots}>
                <Stack gap={3}>
                  {timetables.map(tt => {
                    const slots = tt.timeslots || [];
                    const allSlotIds = slots.map(s => s.id);
                    // No stored prefs for a timetable means all slots are selected (default)
                    const selectedIds = timeslotPrefs[tt.id] !== undefined ? timeslotPrefs[tt.id] : allSlotIds;
                    const allSelected = selectedIds.length === allSlotIds.length || timeslotPrefs[tt.id] === undefined;
                    return (
                      <Stack key={tt.id} gap={2}>
                        <Text size="sm" weight="semibold">{tt.name}</Text>
                        <Row gap={4} wrap>
                          <Checkbox
                            label={<Text tone="muted">{t.all}</Text>}
                            checked={allSelected}
                            onCheckedChange={() => {
                              if (allSelected) {
                                setTimeslotPrefs({ ...timeslotPrefs, [tt.id]: [] });
                              } else {
                                const next = { ...timeslotPrefs };
                                delete next[tt.id];
                                setTimeslotPrefs(next);
                              }
                            }}
                          />
                          {slots.map(slot => {
                            const checked = allSelected || selectedIds.includes(slot.id);
                            return (
                              <Checkbox
                                key={slot.id}
                                label={<Text mono>{slot.start_time}</Text>}
                                checked={checked}
                                onCheckedChange={() => {
                                  const current = allSelected ? [...allSlotIds] : [...selectedIds];
                                  const newIds = checked ? current.filter(id => id !== slot.id) : [...current, slot.id];
                                  if (newIds.length >= allSlotIds.length) {
                                    const next = { ...timeslotPrefs };
                                    delete next[tt.id];
                                    setTimeslotPrefs(next);
                                  } else {
                                    setTimeslotPrefs({ ...timeslotPrefs, [tt.id]: newIds });
                                  }
                                }}
                              />
                            );
                          })}
                        </Row>
                      </Stack>
                    );
                  })}
                </Stack>
              </Field>
            )}
          </Stack>
        </form>
      </Dialog>

      <Dialog
        open={!!cooldownModal}
        onOpenChange={open => { if (!open) setCooldownModal(null); }}
        size="sm"
        title={t.setCooldownTitle}
        description={cooldownModal && t.setCooldownText(`${cooldownModal.first_name} ${cooldownModal.last_name}`)}
        footer={
          <>
            <Button onClick={() => setCooldownModal(null)}>{t.cancel}</Button>
            <Button variant="primary" icon={<Timer />} onClick={handleSetCooldown} disabled={cooldownDays < 1}>{t.setCooldownButton}</Button>
          </>
        }
      >
        <Field
          label={t.cooldownDays}
          htmlFor="cooldown-days"
          hint={cooldownDays > 0 && t.cooldownUntil(new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1000).toLocaleDateString(dateLocale))}
        >
          <Input id="cooldown-days" type="number" min={1} value={cooldownDays} onChange={e => setCooldownDays(Number(e.target.value))} />
        </Field>
      </Dialog>

      <Dialog
        open={!!historyModal}
        onOpenChange={open => { if (!open) setHistoryModal(null); }}
        size="lg"
        title={historyModal ? `${t.invitationHistory} — ${historyModal.first_name} ${historyModal.last_name}` : t.invitationHistory}
        footer={<Button onClick={() => setHistoryModal(null)}>{t.close}</Button>}
      >
        {historyLoading ? (
          <Text tone="muted">{t.loading}</Text>
        ) : historyEntries.length === 0 ? (
          <Text tone="muted">{t.noInvitationHistory}</Text>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t.invitationHistorySession}</th>
                <th>{t.timeslot}</th>
                <th>{t.group}</th>
                <th>{t.invitationHistoryInvitedAt}</th>
                <th>{t.invitationHistoryRespondedAt}</th>
                <th>{t.status}</th>
              </tr>
            </thead>
            <tbody>
              {historyEntries.map(inv => (
                <tr key={inv.id}>
                  <td><Text mono>{new Date(inv.session_date + 'T00:00:00').toLocaleDateString(dateLocale)}</Text></td>
                  <td><Text mono>{inv.start_time.slice(0, 5)}</Text></td>
                  <td>{inv.group_name ? <GroupLabel name={inv.group_name} color={inv.group_color} /> : t.noData}</td>
                  <td><Text mono size="sm">{formatInvitedAt(inv.invited_at)}</Text></td>
                  <td><Text mono size="sm">{inv.responded_at ? formatInvitedAt(inv.responded_at) : t.noData}</Text></td>
                  <td><InvitationStatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Dialog>
    </Page>
  );
}

