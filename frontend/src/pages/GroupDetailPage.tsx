import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Star, Target, Timer, Unlink, Users } from 'lucide-react';
import { api } from '../api';
import {
  ActionMenu, Alert, Badge, Card, Checkbox, EmptyState, Field, Input,
  Page, PageHeader, RadioCards, Row, SortHeader, Stack, Tab, TabList, TabPanel, Table, Tabs, Text, Tooltip,
  useConfirm, useToast,
} from '../ui';
import { cx } from '../ui/cx';
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
  membership_id: string;
  active: number;
  cooldown_until: string | null;
  buddy_group: {
    id: number;
    name: string;
    /** Buddies not in this group, who are never invited together with this member. */
    elsewhere: Array<{ id: number; first_name: string; last_name: string; group_name: string | null }>;
  } | null;
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
  const [sortCol, setSortCol] = useState<keyof Member>('last_name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const toggleSort = (col: keyof Member) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortProps = (col: keyof Member) => ({ active: sortCol === col, direction: sortDir, onSort: () => toggleSort(col) });

  const sortedMembers = [...members].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    // Empty values always sort last
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const load = async () => {
    try {
      const [groupsData, membersData, discData, allDiscData] = await Promise.all([
        api.getGroups(),
        api.getGroupMembers(Number(id)),
        api.getGroupDisciplines(Number(id)),
        api.getDisciplines(),
      ]);
      const g = groupsData.find((g: GroupDetail) => g.id === Number(id));
      if (!g) { setError(t.groupNotFound); return; }
      setGroup(g);
      setMembers(membersData);
      setDisciplines(discData);
      setAllDisciplines(allDiscData.filter((d: DisciplineItem) => d.active));
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
            </Row>

            {members.length === 0 ? (
              <EmptyState icon={<Users />} title={t.noMembers} description={t.noMembersHint} />
            ) : (
              <>
                <Text as="p" tone="muted" size="sm">{t.groupQueueOnTimetables}</Text>
                <Table>
                  <thead>
                    <tr>
                      <SortHeader {...sortProps('last_name')}>{t.name}</SortHeader>
                      <SortHeader {...sortProps('membership_id')}>{t.membershipId}</SortHeader>
                      <SortHeader {...sortProps('active')}>{t.status}</SortHeader>
                      <th data-actions>{t.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMembers.map(m => {
                      const cooldownInfo = getCooldownInfo(m);
                      return (
                        <tr key={m.id}>
                          <td>
                            <Row gap={2}>
                              <Text weight="medium">{m.first_name} {m.last_name}</Text>
                              {m.buddy_group && (
                                <Tooltip content={
                                  <Stack gap={1}>
                                    <span>{t.buddyGroupLabel(m.buddy_group.name)}</span>
                                    {m.buddy_group.elsewhere.map(b => (
                                      <span key={b.id}>
                                        {t.buddyNotTogether(`${b.first_name} ${b.last_name}`, b.group_name ? 'otherGroup' : 'noGroup', b.group_name ?? '')}
                                      </span>
                                    ))}
                                  </Stack>
                                }>
                                  {m.buddy_group.elsewhere.length > 0
                                    ? <span className={cx(styles.flag, styles.warning)}><Unlink /></span>
                                    : <span className={cx(styles.flag, buddyStyles.buddyIcon)} data-muted><Users /></span>}
                                </Tooltip>
                              )}
                            </Row>
                          </td>
                          <td><Text mono tone="muted">{m.membership_id}</Text></td>
                          <td>
                            {cooldownInfo ? (
                              <Tooltip content={t.cooldownDetail(cooldownInfo.days, cooldownInfo.date)}>
                                <span><Badge tone="warning" icon={<Timer />}>{t.cooldown}</Badge></span>
                              </Tooltip>
                            ) : (
                              <Badge tone={m.active ? 'success' : 'neutral'}>{m.active ? t.active : t.inactive}</Badge>
                            )}
                          </td>
                          <td data-actions>
                            <ActionMenu actions={[
                              { label: t.remove, onClick: () => handleRemoveMember(m.id), danger: true },
                            ]} />
                          </td>
                        </tr>
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

