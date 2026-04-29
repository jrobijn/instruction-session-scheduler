import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useT } from '../i18n';

interface Timeslot {
  id: number;
  timetable_id: number;
  start_time: string;
}

interface TimetableGroup {
  group_id: number;
  percentage: number;
  group_name: string;
  priority: number;
  is_default: number;
  group_color: string;
}

interface AvailableGroup {
  id: number;
  name: string;
  priority: number;
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
  const [timetable, setTimetable] = useState<TimetableDetail | null>(null);
  const [editName, setEditName] = useState('');
  const [newTimeslotTime, setNewTimeslotTime] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [allGroups, setAllGroups] = useState<AvailableGroup[]>([]);
  const [groupAssignments, setGroupAssignments] = useState<Array<{ group_id: number; percentage: number }>>([]);
  const [groupError, setGroupError] = useState('');

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
      alert(err.message);
    }
  };

  const addTimeslot = async () => {
    if (!newTimeslotTime) return;
    try {
      await api.addTimetableTimeslot(Number(id), newTimeslotTime);
      setNewTimeslotTime('');
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const deleteTimeslot = async (timeslotId: number) => {
    try {
      await api.deleteTimetableTimeslot(Number(id), timeslotId);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSave = async () => {
    if (!confirm(t.confirmSaveTimetable)) return;
    try {
      await api.saveTimetable(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSetDefault = async () => {
    try {
      await api.setDefaultTimetable(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleToggleActive = async () => {
    try {
      await api.toggleTimetableActive(Number(id));
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async () => {
    if (!confirm(t.confirmDeleteTimetable)) return;
    try {
      await api.deleteTimetable(Number(id));
      navigate('/timetables');
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>{t.loading}</p></div>;
  if (!timetable) return <div className="page"><p>{t.timetableNotFound}</p></div>;

  const isDraft = timetable.status === 'draft';

  const GROUP_COLORS_FALLBACK = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'];

  // Build bar segments from either draft assignments or saved groups
  const barSegments = isDraft
    ? groupAssignments.map((ga, idx) => {
        const group = allGroups.find(g => g.id === ga.group_id);
        return { name: group?.name || `Group ${ga.group_id}`, percentage: ga.percentage, color: group?.color || GROUP_COLORS_FALLBACK[idx % GROUP_COLORS_FALLBACK.length] };
      })
    : timetable.groups.map((g, idx) => ({
        name: g.group_name + (g.is_default ? ` ${t.defaultSuffix}` : ''),
        percentage: g.percentage,
        color: g.group_color || GROUP_COLORS_FALLBACK[idx % GROUP_COLORS_FALLBACK.length],
      }));

  const AllocationBar = () => {
    const total = barSegments.reduce((s, seg) => s + seg.percentage, 0);
    if (barSegments.length === 0) return null;
    return (
      <div style={{ marginBottom: '1rem' }}>
        <div style={{
          display: 'flex', height: '32px', borderRadius: '6px', overflow: 'hidden',
          border: '1px solid #e5e7eb', background: '#f3f4f6',
        }}>
          {barSegments.map((seg, i) => (
            seg.percentage > 0 ? (
              <div key={i} style={{
                width: `${(seg.percentage / Math.max(total, 100)) * 100}%`,
                background: seg.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'white', fontSize: '0.8rem', fontWeight: 600,
                transition: 'width 0.3s ease',
                minWidth: seg.percentage > 0 ? '24px' : 0,
                borderRight: i < barSegments.length - 1 ? '2px solid white' : 'none',
              }}>
                {seg.percentage}%
              </div>
            ) : null
          ))}
        </div>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          {barSegments.map((seg, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
              <span style={{
                width: '12px', height: '12px', borderRadius: '3px',
                background: seg.color, display: 'inline-block', flexShrink: 0,
              }} />
              {seg.name} ({seg.percentage}%)
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <button className="btn btn-outline" onClick={() => navigate('/timetables')} style={{ marginBottom: '1rem' }}>
        {t.backToTimetables}
      </button>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="page-header">
        <h1>{timetable.name}</h1>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className={`badge ${timetable.status === 'saved' ? 'badge-confirmed' : 'badge-draft'}`}>
            {t.statusMap(timetable.status)}
          </span>
          <span className={`badge ${timetable.active ? 'badge-confirmed' : 'badge-declined'}`}>
            {timetable.active ? t.active : t.inactive}
          </span>
          {timetable.is_default ? <span className="badge badge-confirmed">{t.default}</span> : null}
        </div>
      </div>

      {/* Name editing (draft only) */}
      {isDraft && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2>{t.name}</h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input value={editName} onChange={e => setEditName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-outline" onClick={updateName} disabled={editName === timetable.name || !editName}>{t.updateName}</button>
          </div>
        </div>
      )}

      {/* Timeslots Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>{t.timeslotsCount(timetable.timeslots.length)}</h2>
        {isDraft && (
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <input type="time" value={newTimeslotTime} onChange={e => setNewTimeslotTime(e.target.value)} />
            <button className="btn btn-primary" onClick={addTimeslot} disabled={!newTimeslotTime}>{t.addTimeslot}</button>
          </div>
        )}
        {timetable.timeslots.length === 0 ? (
          <p style={{ color: '#6b7280' }}>{t.noTimeslotsDefined}</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {timetable.timeslots.map(ts => (
              <span key={ts.id} className="badge" style={{ fontSize: '0.95rem', padding: '0.4rem 0.8rem', background: '#475569', color: '#ffffff' }}>
                {ts.start_time}
                {isDraft && (
                  <button onClick={() => deleteTimeslot(ts.id)} style={{ marginLeft: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Groups Section */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>{t.groupAllocations}</h2>
        {isDraft ? (
          <>
            <div style={{ marginBottom: '1rem' }}>
              {groupAssignments.map((ga, idx) => {
                const group = allGroups.find(g => g.id === ga.group_id);
                return (
                  <div key={ga.group_id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{ minWidth: '120px' }}>{group?.name || `Group ${ga.group_id}`}</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={ga.percentage}
                      onChange={e => {
                        const newVal = Number(e.target.value);
                        const oldVal = ga.percentage;
                        const diff = newVal - oldVal;
                        if (diff === 0) return;
                        const others = groupAssignments.filter((_, i) => i !== idx);
                        const othersTotal = others.reduce((s, g) => s + g.percentage, 0);
                        const next = groupAssignments.map((g, i) => {
                          if (i === idx) return { ...g, percentage: newVal };
                          if (othersTotal === 0) {
                            // Distribute equally among others
                            const share = Math.floor((100 - newVal) / others.length);
                            return { ...g, percentage: share };
                          }
                          // Distribute the diff proportionally among others
                          const ratio = g.percentage / othersTotal;
                          return { ...g, percentage: Math.max(0, Math.round(g.percentage - diff * ratio)) };
                        });
                        // Fix rounding: adjust to ensure total is exactly 100
                        const total = next.reduce((s, g) => s + g.percentage, 0);
                        if (total !== 100 && next.length > 1) {
                          const fixIdx = next.findIndex((_, i) => i !== idx);
                          if (fixIdx >= 0) next[fixIdx] = { ...next[fixIdx], percentage: next[fixIdx].percentage + (100 - total) };
                        }
                        setGroupAssignments(next);
                      }}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '40px', textAlign: 'right', fontWeight: 500 }}>{ga.percentage}%</span>
                    <button className="btn btn-outline btn-sm" onClick={() => {
                      const removed = groupAssignments[idx];
                      const remaining = groupAssignments.filter((_, i) => i !== idx);
                      if (remaining.length === 0) { setGroupAssignments([]); return; }
                      const remainingTotal = remaining.reduce((s, g) => s + g.percentage, 0);
                      const freed = removed.percentage;
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
                    }}>{t.remove}</button>
                  </div>
                );
              })}
            </div>
            {(() => {
              const assignedIds = new Set(groupAssignments.map(ga => ga.group_id));
              const available = allGroups.filter(g => !assignedIds.has(g.id));
              if (available.length === 0) return null;
              return (
                <div style={{ marginBottom: '1rem' }}>
                  <select
                    onChange={e => {
                      const gid = Number(e.target.value);
                      if (!gid) return;
                      const count = groupAssignments.length + 1;
                      const newShare = Math.floor(100 / count);
                      const oldTotal = 100 - newShare;
                      const currentTotal = groupAssignments.reduce((s, g) => s + g.percentage, 0);
                      const next = groupAssignments.map(g => ({
                        ...g,
                        percentage: currentTotal > 0
                          ? Math.round(g.percentage * oldTotal / currentTotal)
                          : Math.floor(oldTotal / groupAssignments.length),
                      }));
                      // Fix rounding
                      const nextTotal = next.reduce((s, g) => s + g.percentage, 0);
                      const adjustedShare = 100 - nextTotal;
                      next.push({ group_id: gid, percentage: adjustedShare });
                      setGroupAssignments(next);
                      e.target.value = '';
                    }}
                    defaultValue=""
                  >
                    <option value="">{t.addGroupSelect}</option>
                    {available.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </div>
              );
            })()}
            {groupError && <div className="alert alert-error" style={{ marginBottom: '0.5rem' }}>{groupError}</div>}
            <AllocationBar />
            <button className="btn btn-outline" onClick={async () => {
              setGroupError('');
              if (groupAssignments.length === 0) { setGroupError(t.atLeastOneGroup); return; }
              try {
                await api.setTimetableGroups(Number(id), groupAssignments);
                load();
              } catch (err: any) {
                setGroupError(err.message);
              }
            }}>{t.saveGroupAllocations}</button>
          </>
        ) : (
          <>
            {timetable.groups.length === 0 ? (
              <p style={{ color: '#6b7280' }}>{t.noGroupsAssignedTimetable}</p>
            ) : (
              <AllocationBar />
            )}
          </>
        )}
      </div>

      {/* Actions */}
      <div className="card" style={{ marginBottom: '2rem' }}>
        <h2>{t.actions}</h2>
        <div className="btn-group">
          {isDraft && timetable.timeslots.length > 0 && (
            <button className="btn btn-primary" onClick={handleSave}>{t.saveTimetable}</button>
          )}
          {timetable.status === 'saved' && timetable.active && !timetable.is_default && (
            <button className="btn btn-outline" onClick={handleSetDefault}>{t.setAsDefault}</button>
          )}
          <button className="btn btn-outline" onClick={handleToggleActive}>
            {timetable.active ? t.deactivate : t.activate}
          </button>
          <button className="btn btn-danger" onClick={handleDelete}>{t.delete}</button>
        </div>
        {isDraft && (
          <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: '0.5rem' }}>
            {t.saveTimetableHint}
          </p>
        )}
      </div>
    </div>
  );
}
