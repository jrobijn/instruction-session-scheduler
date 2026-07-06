import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import ActionDropdown from '../components/ActionDropdown';
import { useT } from '../i18n';

interface GroupDetail {
  id: number;
  name: string;
  is_default: number;
  active: number;
  new_member_priority: 'highest' | 'lowest';
}

interface Member {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  active: number;
  priority: number;
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

  // Priority editing state (scoped to this group's members)
  const [priorityMode, setPriorityMode] = useState(false);
  const [editedPriorities, setEditedPriorities] = useState<Record<number, number>>({});
  const [showPrioritySavePrompt, setShowPrioritySavePrompt] = useState(false);

  const load = async () => {
    try {
      const [groupsData, membersData, discData, allDiscData] = await Promise.all([
        api.getGroups(),
        api.getGroupMembers(Number(id)),
        api.getGroupDisciplines(Number(id)),
        api.getDisciplines()
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

  const getMemberPriority = (m: Member) =>
    priorityMode && m.id in editedPriorities ? editedPriorities[m.id] : m.priority;

  const togglePriorityMode = () => {
    if (priorityMode) {
      const changedCount = Object.entries(editedPriorities).filter(
        ([mid, prio]) => members.find(m => m.id === Number(mid))?.priority !== prio
      ).length;
      if (changedCount > 0) {
        setShowPrioritySavePrompt(true);
      } else {
        setPriorityMode(false);
        setEditedPriorities({});
      }
    } else {
      setPriorityMode(true);
      setEditedPriorities({});
    }
  };

  const savePriorities = async () => {
    const updates = Object.entries(editedPriorities)
      .filter(([mid, prio]) => members.find(m => m.id === Number(mid))?.priority !== prio)
      .map(([mid, priority]) => ({ id: Number(mid), priority }));
    try {
      await api.bulkUpdatePriorities(updates);
      await load();
    } catch (err: any) {
      alert(err.message);
    }
    setPriorityMode(false);
    setEditedPriorities({});
    setShowPrioritySavePrompt(false);
  };

  const discardPriorities = () => {
    setPriorityMode(false);
    setEditedPriorities({});
    setShowPrioritySavePrompt(false);
  };

  const handleChangeNewMemberPriority = async (value: 'highest' | 'lowest') => {
    if (!group || group.new_member_priority === value) return;
    setGroup({ ...group, new_member_priority: value });
    try {
      await api.updateGroup(group.id, { new_member_priority: value });
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
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
                <button
                  className={`btn ${priorityMode ? 'btn-primary' : 'btn-outline'}`}
                  onClick={togglePriorityMode}
                >
                  {priorityMode ? t.finishAdjusting : t.adjustPriorities}
                </button>
              </div>
              {priorityMode && (
                <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
                  {t.priorityModeHint}
                </div>
              )}
              <table>
                <thead>
                  <tr>
                    <th>{t.priority}</th>
                    <th>{t.firstName}</th>
                    <th>{t.lastName}</th>
                    <th>{t.email}</th>
                    <th>{t.status}</th>
                    <th>{t.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map(m => (
                    <tr key={m.id}>
                      <td>
                        {priorityMode ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <button className="btn btn-outline btn-sm" onClick={() => setEditedPriorities({ ...editedPriorities, [m.id]: Math.max(0, getMemberPriority(m) - 1) })}>−</button>
                            <span style={{ minWidth: '2ch', textAlign: 'center', fontWeight: getMemberPriority(m) !== m.priority ? 700 : 400, color: getMemberPriority(m) !== m.priority ? '#2563eb' : undefined }}>{getMemberPriority(m)}</span>
                            <button className="btn btn-outline btn-sm" onClick={() => setEditedPriorities({ ...editedPriorities, [m.id]: getMemberPriority(m) + 1 })}>+</button>
                          </span>
                        ) : (
                          m.priority
                        )}
                      </td>
                      <td>{m.first_name}</td>
                      <td>{m.last_name}</td>
                      <td>{m.email}</td>
                      <td>
                        <span className={`badge ${m.active ? 'badge-confirmed' : 'badge-declined'}`}>
                          {m.active ? t.active : t.inactive}
                        </span>
                      </td>
                      <td>
                        <ActionDropdown actions={[
                          { label: t.remove, onClick: () => handleRemoveMember(m.id), danger: true },
                        ]} />
                      </td>
                    </tr>
                  ))}
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

      {tab === 'settings' && (
        <div style={{ maxWidth: '640px' }}>
          <h3 style={{ marginTop: 0 }}>{t.newMemberPriorityTitle}</h3>
          <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>{t.newMemberPriorityHint}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: '0.75rem', cursor: 'pointer',
              padding: '0.75rem 1rem', borderRadius: '6px', border: '1px solid',
              borderColor: group.new_member_priority === 'lowest' ? 'var(--primary, #3b82f6)' : 'var(--border)',
              background: group.new_member_priority === 'lowest' ? 'var(--primary-bg, rgba(59,130,246,0.08))' : 'transparent',
            }}>
              <input
                type="radio"
                name="new_member_priority"
                checked={group.new_member_priority === 'lowest'}
                onChange={() => handleChangeNewMemberPriority('lowest')}
                style={{ marginTop: '0.2rem' }}
              />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 500 }}>{t.newMemberPriorityLowest}</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t.newMemberPriorityLowestHint}</span>
              </span>
            </label>
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: '0.75rem', cursor: 'pointer',
              padding: '0.75rem 1rem', borderRadius: '6px', border: '1px solid',
              borderColor: group.new_member_priority === 'highest' ? 'var(--primary, #3b82f6)' : 'var(--border)',
              background: group.new_member_priority === 'highest' ? 'var(--primary-bg, rgba(59,130,246,0.08))' : 'transparent',
            }}>
              <input
                type="radio"
                name="new_member_priority"
                checked={group.new_member_priority === 'highest'}
                onChange={() => handleChangeNewMemberPriority('highest')}
                style={{ marginTop: '0.2rem' }}
              />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 500 }}>{t.newMemberPriorityHighest}</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t.newMemberPriorityHighestHint}</span>
              </span>
            </label>
          </div>
        </div>
      )}

      {showPrioritySavePrompt && (
        <div className="modal-overlay" onClick={discardPriorities}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <h2>{t.adjustPriorities}</h2>
            <p>{t.prioritySavePrompt(
              Object.entries(editedPriorities).filter(
                ([mid, prio]) => members.find(m => m.id === Number(mid))?.priority !== prio
              ).length
            )}</p>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={discardPriorities}>{t.discardChanges}</button>
              <button className="btn btn-primary" onClick={savePriorities}>{t.saveChanges}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
