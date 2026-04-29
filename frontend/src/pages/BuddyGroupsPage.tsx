import { useState, useEffect, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import ActionDropdown from '../components/ActionDropdown';
import { useT } from '../i18n';

interface BuddyGroup {
  id: number;
  name: string;
  member_count: number;
}

export default function BuddyGroupsPage() {
  const navigate = useNavigate();
  const t = useT();
  const [groups, setGroups] = useState<BuddyGroup[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<BuddyGroup | null>(null);
  const [form, setForm] = useState({ name: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setGroups(await api.getBuddyGroups());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (group: BuddyGroup) => {
    setEditing(group);
    setForm({ name: group.name });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        await api.updateBuddyGroup(editing.id, { name: form.name });
      } else {
        await api.createBuddyGroup({ name: form.name });
      }
      setShowModal(false);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (group: BuddyGroup) => {
    if (!confirm(t.confirmDeleteBuddyGroup(group.name))) return;
    try {
      await api.deleteBuddyGroup(group.id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>{t.loading}</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t.buddyGroupsTitle(groups.length)}</h1>
        <div className="btn-group">
          <button className="btn btn-primary" onClick={openCreate}>{t.addBuddyGroupButton}</button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="empty-state">
          <h3>{t.noBuddyGroupsYet}</h3>
          <p>{t.noBuddyGroupsHint}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t.name}</th>
              <th>{t.members}</th>
              <th>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/buddy-groups/${g.id}`)}>
                <td>{g.name}</td>
                <td>{g.member_count}</td>
                <td>
                  <ActionDropdown actions={[
                    { label: t.edit, onClick: () => openEdit(g) },
                    { label: t.delete, onClick: () => handleDelete(g), danger: true },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{editing ? t.editBuddyGroup : t.addBuddyGroupTitle}</h2>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>{t.name}</label>
                <input autoFocus={!editing} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>{t.cancel}</button>
                <button type="submit" className="btn btn-primary">{editing ? t.save : t.addBuddyGroupTitle}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
