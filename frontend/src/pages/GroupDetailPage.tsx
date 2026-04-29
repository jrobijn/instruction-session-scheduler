import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import ActionDropdown from '../components/ActionDropdown';
import { useT } from '../i18n';

interface GroupDetail {
  id: number;
  name: string;
  priority: number;
  is_default: number;
  active: number;
}

interface Member {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  active: number;
}

interface SearchResult {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
}

export default function GroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();
  const dropdownRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const [groupsData, membersData] = await Promise.all([
        api.getGroups(),
        api.getGroupMembers(Number(id))
      ]);
      const g = groupsData.find((g: GroupDetail) => g.id === Number(id));
      if (!g) { setError(t.groupNotFound); return; }
      setGroup(g);
      setMembers(membersData);
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

  if (loading) return <div className="page"><p>{t.loading}</p></div>;
  if (error) return <div className="page"><div className="alert alert-error">{error}</div></div>;
  if (!group) return <div className="page"><p>{t.groupNotFoundText}</p></div>;

  return (
    <div className="page">
      <button className="btn btn-outline" onClick={() => navigate('/groups')} style={{ marginBottom: '1rem' }}>
        {t.backToGroups}
      </button>

      <div className="page-header">
        <h1>{group.is_default ? `${t.default} ${t.defaultSuffix}` : group.name}</h1>
        <span style={{ color: '#666', fontSize: '0.9rem' }}>{t.groupInfo(group.priority, members.length)}</span>
      </div>

      {!group.is_default && (
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
              background: 'white', border: '1px solid #ddd', borderRadius: '4px',
              maxWidth: '400px', width: '100%', maxHeight: '250px', overflowY: 'auto',
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
            }}>
              {searchResults.map(s => (
                <div
                  key={s.id}
                  onClick={() => handleAddMember(s)}
                  style={{
                    padding: '0.5rem 0.75rem', cursor: 'pointer',
                    borderBottom: '1px solid #eee',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f5')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'white')}
                >
                  <span>{s.first_name} {s.last_name}</span>
                  <span style={{ color: '#888', fontSize: '0.85rem' }}>{s.email}</span>
                </div>
              ))}
            </div>
          )}
          {showDropdown && searchQuery.trim() && searchResults.length === 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 10,
              background: 'white', border: '1px solid #ddd', borderRadius: '4px',
              maxWidth: '400px', width: '100%', padding: '0.5rem 0.75rem', color: '#888',
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
            }}>
              {t.noStudentsFound}
            </div>
          )}
        </div>
      )}

      {members.length === 0 ? (
        <div className="empty-state">
          <h3>{t.noMembers}</h3>
          <p>{t.noMembersHint}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t.firstName}</th>
              <th>{t.lastName}</th>
              <th>{t.email}</th>
              <th>{t.status}</th>
              {!group.is_default && <th>{t.actions}</th>}
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <td>{m.first_name}</td>
                <td>{m.last_name}</td>
                <td>{m.email}</td>
                <td>
                  <span className={`badge ${m.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {m.active ? t.active : t.inactive}
                  </span>
                </td>
                {!group.is_default && (
                  <td>
                    <ActionDropdown actions={[
                      { label: t.remove, onClick: () => handleRemoveMember(m.id), danger: true },
                    ]} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
