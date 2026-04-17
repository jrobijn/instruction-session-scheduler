import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import ActionDropdown from '../components/ActionDropdown';

interface DisciplineInfo {
  id: number;
  name: string;
  active: number;
}

interface AssignedGroup {
  id: number;
  name: string;
  priority: number;
  is_default: number;
  active: number;
}

interface AvailableGroup {
  id: number;
  name: string;
  priority: number;
  active: number;
}

export default function DisciplineDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [discipline, setDiscipline] = useState<DisciplineInfo | null>(null);
  const [groups, setGroups] = useState<AssignedGroup[]>([]);
  const [allGroups, setAllGroups] = useState<AvailableGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const [discData, groupsData, allGroupsData] = await Promise.all([
        api.getDisciplines(),
        api.getDisciplineGroups(Number(id)),
        api.getGroups()
      ]);
      const d = discData.find((d: DisciplineInfo) => d.id === Number(id));
      if (!d) { setError('Discipline not found'); return; }
      setDiscipline(d);
      setGroups(groupsData);
      setAllGroups(allGroupsData.filter((g: AvailableGroup) => g.active));
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

  const handleAdd = async (groupId: number) => {
    try {
      await api.addDisciplineGroup(Number(id), groupId);
      setSearchQuery('');
      setShowDropdown(false);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRemove = async (groupId: number) => {
    if (!confirm('Remove this group from the discipline?')) return;
    try {
      await api.removeDisciplineGroup(Number(id), groupId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;
  if (error) return <div className="page"><div className="alert alert-error">{error}</div></div>;
  if (!discipline) return <div className="page"><p>Discipline not found.</p></div>;

  const assignedIds = new Set(groups.map(g => g.id));
  const unassignedGroups = allGroups.filter(g => !assignedIds.has(g.id));

  return (
    <div className="page">
      <button className="btn btn-outline" onClick={() => navigate('/disciplines')} style={{ marginBottom: '1rem' }}>
        &larr; Back to Disciplines
      </button>

      <div className="page-header">
        <h1>{discipline.name}</h1>
        <span style={{ color: '#666', fontSize: '0.9rem' }}>{groups.length} group{groups.length !== 1 ? 's' : ''}</span>
      </div>

      {unassignedGroups.length > 0 && (
        <div style={{ marginBottom: '1.5rem', position: 'relative' }} ref={dropdownRef}>
          <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>Add Group</label>
          <input
            type="text"
            placeholder="Search groups by name..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            style={{ width: '100%', maxWidth: '400px' }}
          />
          {showDropdown && (() => {
            const filtered = unassignedGroups.filter(g =>
              g.name.toLowerCase().includes(searchQuery.toLowerCase())
            );
            if (filtered.length > 0) return (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 10,
                background: 'white', border: '1px solid #ddd', borderRadius: '4px',
                maxWidth: '400px', width: '100%', maxHeight: '250px', overflowY: 'auto',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
              }}>
                {filtered.map(g => (
                  <div
                    key={g.id}
                    onClick={() => handleAdd(g.id)}
                    style={{
                      padding: '0.5rem 0.75rem', cursor: 'pointer',
                      borderBottom: '1px solid #eee',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f5')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'white')}
                  >
                    <span>{g.name}</span>
                    <span style={{ color: '#888', fontSize: '0.85rem' }}>Priority: {g.priority}</span>
                  </div>
                ))}
              </div>
            );
            if (searchQuery.trim()) return (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 10,
                background: 'white', border: '1px solid #ddd', borderRadius: '4px',
                maxWidth: '400px', width: '100%', padding: '0.5rem 0.75rem', color: '#888',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
              }}>
                No groups found
              </div>
            );
            return null;
          })()}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="empty-state">
          <h3>No groups assigned</h3>
          <p>Add groups to control which students can choose this discipline.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.id}>
                <td>{g.name}{g.is_default ? ' (default)' : ''}</td>
                <td>{g.priority}</td>
                <td>
                  <span className={`badge ${g.active ? 'badge-confirmed' : 'badge-declined'}`}>
                    {g.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <ActionDropdown actions={[
                    { label: 'Remove', onClick: () => handleRemove(g.id), danger: true },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
