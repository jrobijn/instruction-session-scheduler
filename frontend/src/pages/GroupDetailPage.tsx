import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import ActionDropdown from '../components/ActionDropdown';
import { useT, getLocale } from '../i18n';

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
  buddy_group?: { id: number; name: string } | null;
}

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
  const [tab, setTab] = useState<'members' | 'disciplines' | 'settings'>('members');
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();
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

  const sortIcon = (col: keyof Member) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const [groupBuddies, setGroupBuddies] = useState(() => localStorage.getItem('groupBuddies') !== 'false');

  const toggleGroupBuddies = () => {
    setGroupBuddies(prev => {
      const next = !prev;
      localStorage.setItem('groupBuddies', String(next));
      return next;
    });
  };

  const sortedMembers = (() => {
    const base = [...members].sort((a, b) => {
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
      if (m.buddy_group) {
        const buddies = base.filter(b => b.id !== m.id && !placed.has(b.id) && b.buddy_group?.id === m.buddy_group!.id);
        for (const b of buddies) {
          result.push(b);
          placed.add(b.id);
        }
      }
    }
    return result;
  })();

  // Assign distinct colors to buddy groups
  const BUDDY_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#c026d3', '#ea580c', '#4f46e5', '#059669'];
  const buddyColorMap = new Map<number, string>();
  const seenBuddyIds = [...new Set(sortedMembers.map(m => m.buddy_group?.id).filter(Boolean))] as number[];
  seenBuddyIds.forEach((bgId, i) => buddyColorMap.set(bgId, BUDDY_COLORS[i % BUDDY_COLORS.length]));

  // Expandable member details
  const [expandedMember, setExpandedMember] = useState<number | null>(null);
  const [clubDays, setClubDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
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
      if (!confirm(t.confirmMoveStudent(student.first_name + ' ' + student.last_name, student.current_group_name))) return;
    }
    try {
      await api.addGroupMember(Number(id), student.id);
      setSearchQuery('');
      setSearchResults([]);
      setShowDropdown(false);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRemoveMember = async (studentId: number) => {
    if (!confirm(t.confirmRemoveMember)) return;
    try {
      await api.removeGroupMember(Number(id), studentId);
      load();
    } catch (err: any) {
      alert(err.message);
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
      alert(err.message);
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
      alert(err.message);
    }
  };

  const handleChangeQueuePolicy = async (field: QueuePolicyField, value: 'front' | 'back') => {
    if (!group || group[field] === value) return;
    setGroup({ ...group, [field]: value });
    try {
      await api.updateGroup(group.id, { [field]: value });
    } catch (err: any) {
      alert(err.message);
      load();
    }
  };

  if (loading) return <div className="page"><p>{t.loading}</p></div>;
  if (error) return <div className="page"><div className="alert alert-error">{error}</div></div>;
  if (!group) return <div className="page"><p>{t.groupNotFoundText}</p></div>;

  const assignedIds = new Set(disciplines.map(d => d.id));

  return (
    <div className="page">
      <button className="btn btn-outline" onClick={() => navigate('/groups')} style={{ marginBottom: '1rem' }}>
        {t.backToGroups}
      </button>

      <div className="page-header">
        <h1>{group.name}{group.is_default ? ` (${t.default})` : ''}</h1>
        <span style={{ color: '#666', fontSize: '0.9rem' }}>{t.groupInfo(members.length)}</span>
      </div>

      <div className="tabs" style={{ display: 'flex', gap: 0, borderBottom: '2px solid var(--border)', marginBottom: '1.5rem' }}>
        <button
          className={`tab-btn${tab === 'members' ? ' active' : ''}`}
          onClick={() => setTab('members')}
          style={{
            padding: '0.5rem 1.25rem', border: 'none', background: 'none', cursor: 'pointer',
            borderBottom: tab === 'members' ? '2px solid var(--primary)' : '2px solid transparent',
            marginBottom: '-2px', fontWeight: tab === 'members' ? 600 : 400,
            color: tab === 'members' ? 'var(--primary)' : 'var(--text-muted)'
          }}
        >
          {t.members} ({members.length})
        </button>
        <button
          className={`tab-btn${tab === 'disciplines' ? ' active' : ''}`}
          onClick={() => setTab('disciplines')}
          style={{
            padding: '0.5rem 1.25rem', border: 'none', background: 'none', cursor: 'pointer',
            borderBottom: tab === 'disciplines' ? '2px solid var(--primary)' : '2px solid transparent',
            marginBottom: '-2px', fontWeight: tab === 'disciplines' ? 600 : 400,
            color: tab === 'disciplines' ? 'var(--primary)' : 'var(--text-muted)'
          }}
        >
          {t.disciplinesSection} ({disciplines.length})
        </button>
        <button
          className={`tab-btn${tab === 'settings' ? ' active' : ''}`}
          onClick={() => setTab('settings')}
          style={{
            padding: '0.5rem 1.25rem', border: 'none', background: 'none', cursor: 'pointer',
            borderBottom: tab === 'settings' ? '2px solid var(--primary)' : '2px solid transparent',
            marginBottom: '-2px', fontWeight: tab === 'settings' ? 600 : 400,
            color: tab === 'settings' ? 'var(--primary)' : 'var(--text-muted)'
          }}
        >
          {t.settingsSection}
        </button>
      </div>

      {tab === 'members' && (
        <>
          <div style={{ marginBottom: '1.5rem', position: 'relative' }} ref={dropdownRef}>
            <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>{t.addMember}</label>
            <input
              type="text"
              placeholder={t.searchStudents}
              value={searchQuery}
              onChange={e => handleSearch(e.target.value)}
              style={{ width: '100%', maxWidth: '400px' }}
            />
            {showDropdown && searchResults.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 10,
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '4px',
                maxWidth: '400px', width: '100%', maxHeight: '250px', overflowY: 'auto',
                boxShadow: '0 4px 12px var(--shadow)'
              }}>
                {searchResults.map(s => (
                  <div
                    key={s.id}
                    onClick={() => handleAddMember(s)}
                    style={{
                      padding: '0.5rem 0.75rem', cursor: 'pointer',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface)')}
                  >
                    <span>{s.first_name} {s.last_name}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{s.email}</span>
                  </div>
                ))}
              </div>
            )}
            {showDropdown && searchQuery.trim() && searchResults.length === 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 10,
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '4px',
                maxWidth: '400px', width: '100%', padding: '0.5rem 0.75rem', color: 'var(--text-muted)',
                boxShadow: '0 4px 12px var(--shadow)'
              }}>
                {t.noStudentsFound}
              </div>
            )}
          </div>

          {members.length === 0 ? (
            <div className="empty-state">
              <h3>{t.noMembers}</h3>
              <p>{t.noMembersHint}</p>
            </div>
          ) : (
            <>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 0 }}>{t.queueHint}</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
                {members.some(m => m.buddy_group) && (
                  <button
                    className="btn btn-outline"
                    onClick={toggleGroupBuddies}
                    title={groupBuddies ? t.groupBuddiesOn : t.groupBuddiesOff}
                    style={{
                      padding: '0.4rem 0.5rem', lineHeight: 1, marginRight: '0.5rem',
                      ...(groupBuddies ? { background: 'var(--hover-row)', color: 'var(--text)' } : {}),
                    }}
                  >
                    <svg style={{ width: '16px', height: '16px', verticalAlign: 'middle' }} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                    </svg>
                  </button>
                )}
              </div>
              <table>
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => toggleSort('queue_position')}>{t.queuePosition}{sortIcon('queue_position')}</th>
                    <th className="sortable" onClick={() => toggleSort('last_name')}>{t.name}{sortIcon('last_name')}</th>
                    <th className="sortable" onClick={() => toggleSort('last_turn_at')}>{t.lastInvited}{sortIcon('last_turn_at')}</th>
                    <th className="sortable" onClick={() => toggleSort('active_invitations')}>{t.invitationsColumn}{sortIcon('active_invitations')}</th>
                    <th className="sortable" onClick={() => toggleSort('active')}>{t.status}{sortIcon('active')}</th>
                    <th>{t.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMembers.map((m, idx) => {
                    const isExpanded = expandedMember === m.id;
                    // Buddy group visual grouping
                    const hasBuddy = !!m.buddy_group;
                    const buddyColor = hasBuddy ? buddyColorMap.get(m.buddy_group!.id) || '#3b82f6' : '';
                    const isFirstInBuddy = hasBuddy && (idx === 0 || sortedMembers[idx - 1].buddy_group?.id !== m.buddy_group!.id);
                    const isLastInBuddy = hasBuddy && (idx === sortedMembers.length - 1 || sortedMembers[idx + 1].buddy_group?.id !== m.buddy_group!.id);
                    const buddyRowStyle = hasBuddy ? {
                      borderLeft: `3px solid ${buddyColor}`,
                      background: `${buddyColor}08`,
                      ...(isFirstInBuddy ? { borderTop: `1px solid ${buddyColor}` } : {}),
                      ...(isLastInBuddy ? { borderBottom: `1px solid ${buddyColor}` } : {}),
                    } : {};
                    return (
                    <>
                    <tr
                      key={m.id}
                      onClick={() => { if (isExpanded) setExpandedMember(null); else openMemberDetails(m.id); }}
                      style={{ cursor: 'pointer', ...buddyRowStyle }}
                    >
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                          {m.queue_position ?? '—'}
                          {m.queue_override && !m.invite_next && m.queue_position != null && (
                            <span
                              title={t.queueOverrideTooltip(
                                m.queue_override.reason,
                                new Date(m.queue_override.at.replace(' ', 'T') + 'Z').toLocaleDateString(getLocale() === 'nl' ? 'nl-NL' : 'en-GB'),
                              )}
                              style={{ display: 'inline-flex', cursor: 'help' }}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                                <circle cx="12" cy="12" r="10"/>
                                <path d="M12 7v6"/>
                                <path d="M12 17h.01"/>
                              </svg>
                            </span>
                          )}
                          {m.invite_next && (
                            <span title={t.inviteNextTooltip} style={{ display: 'inline-flex', cursor: 'help' }}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                                <circle cx="12" cy="12" r="10"/>
                                <path d="M12 7v6"/>
                                <path d="M12 17h.01"/>
                              </svg>
                            </span>
                          )}
                        </span>
                      </td>
                      <td>
                        {m.first_name} {m.last_name}
                        {m.buddy_group && (
                          <svg style={{ width: '14px', height: '14px', flexShrink: 0, marginLeft: '0.4rem', verticalAlign: 'middle' }} viewBox="0 0 24 24" fill={buddyColor} xmlns="http://www.w3.org/2000/svg">
                            <title>{t.buddyScheduledTogether(m.buddy_group.name)}</title>
                            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                          </svg>
                        )}
                      </td>
                      <td>
                        {m.last_turn_at
                          ? new Date(m.last_turn_at.slice(0, 10) + 'T00:00:00').toLocaleDateString(getLocale() === 'nl' ? 'nl-NL' : 'en-GB')
                          : t.neverInvited}
                      </td>
                      <td>{m.active_invitations}</td>
                      <td>
                        {(() => {
                          const cooldownInfo = getCooldownInfo(m);
                          if (cooldownInfo) {
                            return (
                              <span className="badge badge-pending" title={t.cooldownDetail(cooldownInfo.days, cooldownInfo.date)}>
                                {t.cooldown}
                              </span>
                            );
                          }
                          return (
                            <span className={`badge ${m.active ? 'badge-confirmed' : 'badge-declined'}`}>
                              {m.active ? t.active : t.inactive}
                            </span>
                          );
                        })()}
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <ActionDropdown actions={[
                          { label: m.invite_next ? t.cancelInviteNext : t.inviteNext, onClick: () => handleToggleInviteNext(m) },
                          { label: t.remove, onClick: () => handleRemoveMember(m.id), danger: true },
                        ]} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${m.id}-details`}>
                        <td colSpan={6} style={{ background: 'var(--bg)', padding: '1rem 1.5rem' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem 2rem' }}>
                            <div>
                              <div>
                                <strong>{t.preferredDays}:</strong>
                                <div style={{ marginTop: '0.25rem' }}>{m.preferred_days ? m.preferred_days.split('|').filter(d => clubDays.includes(Number(d))).map(d => t.days[Number(d)]).join(', ') || t.noData : t.noData}</div>
                              </div>
                              {detailTimetables.length > 0 && (
                                <div style={{ marginTop: '0.5rem' }}>
                                  <strong>{t.preferredTimeslots}:</strong>
                                  {detailTimetables.map(tt => {
                                    const slots = tt.timeslots || [];
                                    const prefIds = detailTimeslotPrefs[tt.id];
                                    const display = prefIds && prefIds.length > 0
                                      ? slots.filter(sl => prefIds.includes(sl.id)).map(sl => sl.start_time.slice(0, 5)).join(', ')
                                      : null;
                                    return (
                                      <div key={tt.id} style={{ marginTop: '0.25rem' }}>
                                        <em>{tt.name}:</em> {display || t.noData}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                            <div>
                              <strong>{t.activeInvitations}:</strong>
                              {detailInvitations.length > 0 ? (
                                <div style={{ marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                  {detailInvitations.map(inv => (
                                    <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                      <span>{new Date(inv.session_date + 'T00:00:00').toLocaleDateString(getLocale() === 'nl' ? 'nl-NL' : 'en-GB')} — {inv.start_time.slice(0, 5)}</span>
                                      <span className={`badge ${inv.status === 'confirmed' ? 'badge-confirmed' : 'badge-pending'}`}>{t.statusMap(inv.status)}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ marginTop: '0.25rem' }}>{t.noData}</div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {tab === 'disciplines' && (
        <>
          {allDisciplines.length === 0 ? (
            <div className="empty-state">
              <h3>{t.noDisciplinesAssigned}</h3>
              <p>{t.noDisciplinesAssignedHint}</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.5rem' }}>
              {allDisciplines.map(d => {
                const checked = assignedIds.has(d.id);
                return (
                  <label key={d.id} style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer',
                    padding: '0.6rem 0.75rem', borderRadius: '6px',
                    background: checked ? 'var(--primary-bg, rgba(59,130,246,0.08))' : 'transparent',
                    border: '1px solid',
                    borderColor: checked ? 'var(--primary, #3b82f6)' : 'var(--border)',
                    transition: 'all 0.15s ease'
                  }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleToggleDiscipline(d.id, checked)}
                      style={{ width: '16px', height: '16px' }}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontWeight: 500 }}>{d.name}</span>
                      {d.abbreviation && <span style={{ fontSize: '0.8rem', fontStyle: 'italic', color: 'var(--text-muted)' }}>{d.abbreviation}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === 'settings' && (() => {
        const queueOptions: Array<{ value: 'back' | 'front'; label: string; hint: string }> = [
          { value: 'back', label: t.queueBack, hint: t.queueBackHint },
          { value: 'front', label: t.queueFront, hint: t.queueFrontHint },
        ];
        const renderChoice = (
          radioName: QueuePolicyField,
          current: 'back' | 'front',
        ) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
            {queueOptions.map(opt => (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.75rem', cursor: 'pointer',
                padding: '0.75rem 1rem', borderRadius: '6px', border: '1px solid',
                borderColor: current === opt.value ? 'var(--primary, #3b82f6)' : 'var(--border)',
                background: current === opt.value ? 'var(--primary-bg, rgba(59,130,246,0.08))' : 'transparent',
              }}>
                <input
                  type="radio"
                  name={radioName}
                  checked={current === opt.value}
                  onChange={() => handleChangeQueuePolicy(radioName, opt.value)}
                  style={{ marginTop: '0.2rem' }}
                />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 500 }}>{opt.label}</span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
        );
        return (
          <div style={{ maxWidth: '640px' }}>
            <h3 style={{ marginTop: 0 }}>{t.newMemberQueueTitle}</h3>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t.newMemberQueueHint}</p>
            {renderChoice('new_member_priority', group.new_member_priority)}

            <h3 style={{ marginTop: '2rem' }}>{t.reactivatedMemberQueueTitle}</h3>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t.reactivatedMemberQueueHint}</p>
            {renderChoice('reactivated_member_priority', group.reactivated_member_priority)}

            <h3 style={{ marginTop: '2rem' }}>{t.cooldownMemberQueueTitle}</h3>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t.cooldownMemberQueueHint}</p>
            {renderChoice('cooldown_member_priority', group.cooldown_member_priority)}
          </div>
        );
      })()}
    </div>
  );
}
