import { Fragment, useState, useEffect, useRef, type CSSProperties } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { CalendarX, ChevronsDown, ChevronsUp, Layers, Link2, Star, Target, Timer, Users } from 'lucide-react';
import { api } from '../api';
import {
  ActionMenu, Alert, Badge, Button, Card, Checkbox, DescriptionList, EmptyState, ExpandIcon, Field, Input,
  Page, PageHeader, RadioCards, Row, SegmentedControl, SortHeader, Stack, Tab, TabList, TabPanel, Table, Tabs, Text, Tooltip,
  useConfirm, useToast,
} from '../ui';
import { cx } from '../ui/cx';
import { InvitationStatusBadge } from '../components/StatusBadges';
import { StudentSearchResults } from '../components/StudentSearchResults';
import { useT, getLocale } from '../i18n';
import styles from './GroupDetailPage.module.css';
import buddyStyles from '../components/BuddyRows.module.css';

interface GroupDetail {
  id: number;
  name: string;
  is_default: number;
  active: number;
  new_member_priority: 'front' | 'back';
  reactivated_member_priority: 'front' | 'back';
  cooldown_member_priority: 'front' | 'back';
}

type QueuePolicyField = 'new_member_priority' | 'reactivated_member_priority' | 'cooldown_member_priority';

interface Member {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  active: number;
  queue_position: number | null;
  last_turn_at: string | null;
  invite_next: boolean;
  queue_override: { reason: 'joined' | 'reactivated' | 'cooldown'; at: string } | null;
  cooldown_until: string | null;
  preferred_days: string;
  active_invitations: number;
  buddy_group?: {
    id: number;
    name: string;
    buddies: Array<{ id: number; first_name: string; last_name: string; group_id: number | null; group_name: string | null }>;
  } | null;
}

type ApartReason = 'otherGroup' | 'noGroup' | 'inactive' | 'cooldown' | 'otherDay';

interface Timetable {
  id: number;
  name: string;
  active: number;
  status: string;
  timeslots?: Array<{ id: number; start_time: string }>;
}

interface StudentInvitation {
  id: number;
  status: string;
  session_date: string;
  start_time: string;
}

interface SearchResult {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  current_group_name?: string;
}

interface DisciplineItem {
  id: number;
  name: string;
  abbreviation: string;
  active: number;
}

export default function GroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [tab, setTab] = useState<'members' | 'disciplines' | 'settings'>('members');
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Disciplines state
  const [disciplines, setDisciplines] = useState<DisciplineItem[]>([]);
  const [allDisciplines, setAllDisciplines] = useState<DisciplineItem[]>([]);

  // Members table sorting
  const [sortCol, setSortCol] = useState<keyof Member>('queue_position');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const toggleSort = (col: keyof Member) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortProps = (col: keyof Member) => ({ active: sortCol === col, direction: sortDir, onSort: () => toggleSort(col) });

  const [groupBuddies, setGroupBuddies] = useState(() => localStorage.getItem('groupBuddies') !== 'false');

  const toggleGroupBuddies = () => {
    setGroupBuddies(prev => {
      const next = !prev;
      localStorage.setItem('groupBuddies', String(next));
      return next;
    });
  };

  // Mirrors generate-schedule: only active buddies within this group are invited together
  const unavailableReason = (m: Member): ApartReason | null =>
    !m.active ? 'inactive' : m.cooldown_until && new Date(m.cooldown_until + 'Z') > new Date() ? 'cooldown' : null;

  const [clubDays, setClubDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [queueDayPref, setQueueDayPref] = useState<number | null>(() => {
    const stored = localStorage.getItem('groupQueueDay');
    return stored ? Number(stored) : null;
  });
  const queueDay = queueDayPref != null && clubDays.includes(queueDayPref) ? queueDayPref : null;
  const changeQueueDay = (value: string) => {
    const day = value === 'all' ? null : Number(value);
    setQueueDayPref(day);
    if (day == null) localStorage.removeItem('groupQueueDay');
    else localStorage.setItem('groupQueueDay', String(day));
  };
  const availableOn = (m: Member, day: number) => `|${m.preferred_days ?? ''}|`.includes(`|${day}|`);

  // With a day selected: only members the scheduler considers for that weekday, renumbered in queue order
  const queueMembers = queueDay == null ? members : members
    .filter(m => m.active && availableOn(m, queueDay))
    .sort((a, b) => a.queue_position! - b.queue_position!)
    .map((m, i) => ({ ...m, queue_position: i + 1 }));

  const buddyLinks = new Map<number, { together: Member[]; apart: Array<{ name: string; reason: ApartReason; detail: string }> }>();
  for (const m of queueMembers) {
    if (!m.buddy_group) continue;
    const selfReason = unavailableReason(m);
    const together: Member[] = [];
    const apart: Array<{ name: string; reason: ApartReason; detail: string }> = [];
    for (const b of m.buddy_group.buddies) {
      const name = `${b.first_name} ${b.last_name}`;
      const bm = members.find(x => x.id === b.id);
      if (!bm) {
        apart.push(b.group_name ? { name, reason: 'otherGroup', detail: b.group_name } : { name, reason: 'noGroup', detail: '' });
        continue;
      }
      const buddyReason = unavailableReason(bm);
      if (buddyReason) apart.push({ name, reason: buddyReason, detail: bm.first_name });
      else if (selfReason) apart.push({ name, reason: selfReason, detail: m.first_name });
      else if (queueDay != null && !availableOn(bm, queueDay)) apart.push({ name, reason: 'otherDay', detail: t.daysFull[queueDay] });
      else together.push(queueMembers.find(x => x.id === b.id)!);
    }
    buddyLinks.set(m.id, { together, apart });
  }
  const linkedBuddyId = (m: Member) => buddyLinks.get(m.id)?.together.length ? m.buddy_group!.id : undefined;

  const sortedMembers = (() => {
    const base = [...queueMembers].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      // Empty values (e.g. inactive members' queue position, never invited) always sort last
      if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    // Group buddy members together: place them after the first buddy in sort order
    if (!groupBuddies) return base;
    const placed = new Set<number>();
    const result: Member[] = [];
    for (const m of base) {
      if (placed.has(m.id)) continue;
      result.push(m);
      placed.add(m.id);
      const linkedId = linkedBuddyId(m);
      if (linkedId) {
        const buddies = base.filter(b => b.id !== m.id && !placed.has(b.id) && linkedBuddyId(b) === linkedId);
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
  const seenBuddyIds = [...new Set(sortedMembers.map(linkedBuddyId).filter(Boolean))] as number[];
  seenBuddyIds.forEach((bgId, i) => buddyColorMap.set(bgId, BUDDY_COLORS[i % BUDDY_COLORS.length]));

  // Expandable member details
  const [expandedMember, setExpandedMember] = useState<number | null>(null);
  const [detailTimetables, setDetailTimetables] = useState<Timetable[]>([]);
  const [detailTimeslotPrefs, setDetailTimeslotPrefs] = useState<Record<number, number[]>>({});
  const [detailInvitations, setDetailInvitations] = useState<StudentInvitation[]>([]);

  const openMemberDetails = async (memberId: number) => {
    setExpandedMember(memberId);
    try {
      const allTt = await api.getTimetables();
      const active = allTt.filter((tt: Timetable) => tt.active && tt.status === 'saved');
      const withTs = await Promise.all(active.map(async (tt: Timetable) => {
        const detail = await api.getTimetable(tt.id);
        return { ...tt, timeslots: detail.timeslots };
      }));
      setDetailTimetables(withTs);
      const [prefs, invitations] = await Promise.all([
        api.getStudentPreferredTimeslots(memberId),
        api.getStudentInvitations(memberId),
      ]);
      setDetailTimeslotPrefs(prefs);
      setDetailInvitations(invitations);
    } catch {
      setDetailTimetables([]);
      setDetailTimeslotPrefs({});
      setDetailInvitations([]);
    }
  };


  const load = async () => {
    try {
      const [groupsData, membersData, discData, allDiscData, settingsData] = await Promise.all([
        api.getGroups(),
        api.getGroupMembers(Number(id)),
        api.getGroupDisciplines(Number(id)),
        api.getDisciplines(),
        api.getSettings()
      ]);
      const g = groupsData.find((g: GroupDetail) => g.id === Number(id));
      if (!g) { setError(t.groupNotFound); return; }
      setGroup(g);
      setMembers(membersData);
      setDisciplines(discData);
      setAllDisciplines(allDiscData.filter((d: DisciplineItem) => d.active));
      setClubDays((settingsData.club_days || '0|1|2|3|4|5|6').split('|').map(Number));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!query.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    searchTimeout.current = setTimeout(async () => {
      try {
        const results = await api.searchGroupNonMembers(Number(id), query);
        setSearchResults(results);
        setShowDropdown(true);
      } catch { /* ignore */ }
    }, 300);
  };

  const handleAddMember = async (student: SearchResult) => {
    if (student.current_group_name) {
      const moveMessage = t.confirmMoveStudent(student.first_name + ' ' + student.last_name, student.current_group_name);
      if (!await confirm({ title: t.addMember, message: moveMessage })) return;
    }
    try {
      await api.addGroupMember(Number(id), student.id);
      setSearchQuery('');
      setSearchResults([]);
      setShowDropdown(false);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleRemoveMember = async (studentId: number) => {
    if (!await confirm({ title: t.remove, message: t.confirmRemoveMember, confirmLabel: t.remove, danger: true })) return;
    try {
      await api.removeGroupMember(Number(id), studentId);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleToggleDiscipline = async (disciplineId: number, assigned: boolean) => {
    try {
      if (assigned) {
        await api.removeGroupDiscipline(Number(id), disciplineId);
      } else {
        await api.addGroupDiscipline(Number(id), disciplineId);
      }
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const getCooldownInfo = (m: Member) => {
    if (!m.cooldown_until || new Date(m.cooldown_until + 'Z') <= new Date()) return null;
    const until = new Date(m.cooldown_until + 'Z');
    const days = Math.ceil((until.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
    return { days, date: until.toLocaleDateString(dateLocale) };
  };

  const handleToggleInviteNext = async (m: Member) => {
    try {
      await api.setGroupMemberInviteNext(Number(id), m.id, !m.invite_next);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleChangeQueuePolicy = async (field: QueuePolicyField, value: 'front' | 'back') => {
    if (!group || group[field] === value) return;
    setGroup({ ...group, [field]: value });
    try {
      await api.updateGroup(group.id, { [field]: value });
      setMembers(await api.getGroupMembers(group.id));
    } catch (err: any) {
      toast(err.message);
      load();
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;
  if (error) return <Page><Alert tone="danger">{error}</Alert></Page>;
  if (!group) return <Page><Text tone="muted">{t.groupNotFoundText}</Text></Page>;

  const assignedIds = new Set(disciplines.map(d => d.id));
  const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
  const groupBuddiesLabel = groupBuddies ? t.groupBuddiesOn : t.groupBuddiesOff;
  const queueOptions = [
    { value: 'back' as const, label: t.queueBack, description: t.queueBackHint },
    { value: 'front' as const, label: t.queueFront, description: t.queueFrontHint },
  ];
  const queuePolicies: Array<{ field: QueuePolicyField; title: string; hint: string }> = [
    { field: 'new_member_priority', title: t.newMemberQueueTitle, hint: t.newMemberQueueHint },
    { field: 'reactivated_member_priority', title: t.reactivatedMemberQueueTitle, hint: t.reactivatedMemberQueueHint },
    { field: 'cooldown_member_priority', title: t.cooldownMemberQueueTitle, hint: t.cooldownMemberQueueHint },
  ];

  return (
    <Page>
      <PageHeader
        back={{ label: t.backToGroups, onClick: () => navigate('/groups') }}
        title={group.name}
        meta={
          <>
            {group.is_default ? <Badge tone="accent" icon={<Star />}>{t.default}</Badge> : null}
            <Text tone="muted" size="sm">{t.groupInfo(members.length)}</Text>
          </>
        }
      />

      <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)}>
        <TabList>
          <Tab value="members">{t.members} <Text mono tone="muted">{members.length}</Text></Tab>
          <Tab value="disciplines">{t.disciplinesSection} <Text mono tone="muted">{disciplines.length}</Text></Tab>
          <Tab value="settings">{t.settingsSection}</Tab>
        </TabList>

        <TabPanel value="members">
          <Stack gap={4}>
            <Row justify="between" align="end" gap={3} wrap>
              <div className={styles.search} ref={dropdownRef}>
                <Field label={t.addMember} htmlFor="member-search">
                  <Input
                    id="member-search"
                    type="search"
                    autoComplete="off"
                    placeholder={t.searchStudents}
                    value={searchQuery}
                    onChange={e => handleSearch(e.target.value)}
                  />
                </Field>
                {showDropdown && searchQuery.trim() && (
                  <StudentSearchResults results={searchResults} onSelect={handleAddMember} emptyText={t.noStudentsFound} />
                )}
              </div>
              <Row align="end" gap={2}>
                {members.length > 0 && clubDays.length > 1 && (
                  <Field label={t.queueDay}>
                    <SegmentedControl
                      aria-label={t.queueDay}
                      value={queueDay == null ? 'all' : String(queueDay)}
                      onValueChange={changeQueueDay}
                      options={[
                        { value: 'all', label: t.allDaysOption },
                        ...[...clubDays].sort().map(d => ({ value: String(d), label: t.days[d] })),
                      ]}
                    />
                  </Field>
                )}
                {queueMembers.some(m => linkedBuddyId(m)) && (
                  <Tooltip content={groupBuddiesLabel}>
                    <Button icon={<Layers />} aria-label={groupBuddiesLabel} pressed={groupBuddies} onClick={toggleGroupBuddies} />
                  </Tooltip>
                )}
              </Row>
            </Row>

            {members.length === 0 ? (
              <EmptyState icon={<Users />} title={t.noMembers} description={t.noMembersHint} />
            ) : queueMembers.length === 0 ? (
              <EmptyState icon={<CalendarX />} title={t.noMembersOnDay(t.daysFull[queueDay!])} />
            ) : (
              <>
                <Text as="p" tone="muted" size="sm">
                  {t.queueHint}
                  {queueDay != null && <> {t.queueDayHint(t.daysFull[queueDay])}</>}
                </Text>
                <Table interactive>
                  <thead>
                    <tr>
                      <SortHeader numeric shrink {...sortProps('queue_position')}>{t.queuePosition}</SortHeader>
                      <SortHeader {...sortProps('last_name')}>{t.name}</SortHeader>
                      <SortHeader {...sortProps('last_turn_at')}>{t.lastInvited}</SortHeader>
                      <SortHeader numeric {...sortProps('active_invitations')}>{t.invitationsColumn}</SortHeader>
                      <SortHeader {...sortProps('active')}>{t.status}</SortHeader>
                      <th data-actions>{t.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMembers.map((m, idx) => {
                      const isExpanded = expandedMember === m.id;
                      const buddyId = linkedBuddyId(m);
                      const isFirstInBuddy = !!buddyId && (idx === 0 || linkedBuddyId(sortedMembers[idx - 1]) !== buddyId);
                      const isLastInBuddy = !!buddyId && (idx === sortedMembers.length - 1 || linkedBuddyId(sortedMembers[idx + 1]) !== buddyId);
                      const buddyLink = buddyLinks.get(m.id);
                      // The buddy first in the queue takes the others along
                      const buddyLeader = buddyLink?.together.reduce<Member | null>(
                        (best, b) => b.queue_position! < (best ?? m).queue_position! ? b : best, null);
                      const cooldownInfo = getCooldownInfo(m);
                      const preferredDays = m.preferred_days
                        ? m.preferred_days.split('|').filter(d => clubDays.includes(Number(d))).map(d => t.days[Number(d)]).join(', ') || t.noData
                        : t.noData;
                      return (
                        <Fragment key={m.id}>
                          <tr
                            className={buddyId ? buddyStyles.buddyRow : undefined}
                            style={buddyId ? { '--buddy': buddyColorMap.get(buddyId) } as CSSProperties : undefined}
                            data-first={isFirstInBuddy || undefined}
                            data-last={isLastInBuddy || undefined}
                            data-expanded={isExpanded || undefined}
                            onClick={() => { if (isExpanded) setExpandedMember(null); else openMemberDetails(m.id); }}
                          >
                            <td data-numeric data-shrink>
                              <Row gap={1} justify="end">
                                {m.queue_override && !m.invite_next && m.queue_position != null && (
                                  <Tooltip content={t.queueOverrideTooltip(
                                    m.queue_override.reason,
                                    new Date(m.queue_override.at.replace(' ', 'T') + 'Z').toLocaleDateString(dateLocale),
                                    new Date(m.queue_override.at.replace(' ', 'T') + 'Z') > new Date(),
                                  )}>
                                    <span className={cx(styles.flag, styles.warning)}><ChevronsDown /></span>
                                  </Tooltip>
                                )}
                                {m.invite_next && (
                                  <Tooltip content={t.inviteNextTooltip}>
                                    <span className={cx(styles.flag, styles.success)}><ChevronsUp /></span>
                                  </Tooltip>
                                )}
                                {buddyLeader && (
                                  <Tooltip content={t.buddyFollowerTooltip(`${buddyLeader.first_name} ${buddyLeader.last_name}`, buddyLeader.queue_position!)}>
                                    <span className={cx(styles.flag, buddyStyles.buddyIcon)}><Link2 /></span>
                                  </Tooltip>
                                )}
                                <span>{m.queue_position ?? '—'}</span>
                              </Row>
                            </td>
                            <td>
                              <Row gap={2}>
                                <ExpandIcon expanded={isExpanded} />
                                <Text weight="medium">{m.first_name} {m.last_name}</Text>
                                {buddyLink && (
                                  <Tooltip content={
                                    <Stack gap={1}>
                                      {buddyLink.together.length > 0 && (
                                        <span>{t.buddyInvitedTogether(buddyLink.together.map(b => `${b.first_name} ${b.last_name}`).join(' & '))}</span>
                                      )}
                                      {buddyLink.apart.map(a => <span key={a.name}>{t.buddyNotTogether(a.name, a.reason, a.detail)}</span>)}
                                    </Stack>
                                  }>
                                    <span className={cx(styles.flag, buddyStyles.buddyIcon)} data-muted={buddyLink.together.length === 0 || undefined}>
                                      <Users />
                                    </span>
                                  </Tooltip>
                                )}
                              </Row>
                            </td>
                            <td>
                              {m.last_turn_at
                                ? <Text mono>{new Date(m.last_turn_at.slice(0, 10) + 'T00:00:00').toLocaleDateString(dateLocale)}</Text>
                                : <Text tone="subtle">{t.neverInvited}</Text>}
                            </td>
                            <td data-numeric>{m.active_invitations}</td>
                            <td>
                              {cooldownInfo ? (
                                <Tooltip content={t.cooldownDetail(cooldownInfo.days, cooldownInfo.date)}>
                                  <span><Badge tone="warning" icon={<Timer />}>{t.cooldown}</Badge></span>
                                </Tooltip>
                              ) : (
                                <Badge tone={m.active ? 'success' : 'neutral'}>{m.active ? t.active : t.inactive}</Badge>
                              )}
                            </td>
                            <td data-actions onClick={e => e.stopPropagation()}>
                              <ActionMenu actions={[
                                { label: m.invite_next ? t.cancelInviteNext : t.inviteNext, onClick: () => handleToggleInviteNext(m) },
                                { label: t.remove, onClick: () => handleRemoveMember(m.id), danger: true },
                              ]} />
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr data-detail>
                              <td colSpan={6}>
                                <DescriptionList columns={3} items={[
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
                                  {
                                    label: t.activeInvitations,
                                    value: detailInvitations.length > 0 ? (
                                      <Stack gap={1}>
                                        {detailInvitations.map(inv => (
                                          <Row key={inv.id} gap={2}>
                                            <Text mono>
                                              {new Date(inv.session_date + 'T00:00:00').toLocaleDateString(dateLocale)} {inv.start_time.slice(0, 5)}
                                            </Text>
                                            <InvitationStatusBadge status={inv.status} />
                                          </Row>
                                        ))}
                                      </Stack>
                                    ) : t.noData,
                                  },
                                ]} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </Table>
              </>
            )}
          </Stack>
        </TabPanel>

        <TabPanel value="disciplines">
          {allDisciplines.length === 0 ? (
            <EmptyState icon={<Target />} title={t.noDisciplinesAssigned} description={t.noDisciplinesAssignedHint} />
          ) : (
            <div className={styles.disciplineGrid}>
              {allDisciplines.map(d => {
                const checked = assignedIds.has(d.id);
                return (
                  <Checkbox
                    key={d.id}
                    card
                    checked={checked}
                    label={d.name}
                    description={d.abbreviation || undefined}
                    onCheckedChange={() => handleToggleDiscipline(d.id, checked)}
                  />
                );
              })}
            </div>
          )}
        </TabPanel>

        <TabPanel value="settings">
          <Card>
            <Stack gap={4}>
              {queuePolicies.map(policy => (
                <Field split="wide" key={policy.field} label={policy.title} hint={policy.hint}>
                  <RadioCards
                    aria-label={policy.title}
                    value={group[policy.field]}
                    onValueChange={v => handleChangeQueuePolicy(policy.field, v)}
                    options={queueOptions}
                  />
                </Field>
              ))}
            </Stack>
          </Card>
        </TabPanel>
      </Tabs>
    </Page>
  );
}

