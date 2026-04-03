import { useState, useEffect } from 'react';
import { api } from '../api';

interface Settings {
  [key: string]: string;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState('');

  const load = async () => {
    try {
      setSettings(await api.getSettings());
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const saveSetting = async (key: string, value: string) => {
    try {
      await api.updateSetting(key, value);
      setSaved(key);
      setTimeout(() => setSaved(''), 2000);
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  const settingsConfig = [
    { key: 'club_name', label: 'Club Name', type: 'text', description: 'Name of the sports club, used in emails.' },
    { key: 'invitation_email_subject', label: 'Invitation Email Subject', type: 'text', description: 'Subject line for invitation emails sent to students.' },
  ];

  return (
    <div className="page">
      <h1>Settings</h1>
      <div className="card">
        {settingsConfig.map(({ key, label, type, description }) => (
          <div key={key} className="form-group">
            <label>{label}</label>
            <input
              type={type}
              value={settings[key] || ''}
              onChange={e => setSettings({ ...settings, [key]: e.target.value })}
              onBlur={e => saveSetting(key, e.target.value)}
            />
            <small style={{ color: '#6b7280' }}>{description}</small>
            {saved === key && <small style={{ color: '#10b981', marginLeft: '0.5rem' }}>✓ Saved</small>}
          </div>
        ))}

        <div className="form-group">
          <label>Club Days</label>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {DAY_LABELS.map((label, idx) => {
              const days = (settings.club_days || '0|1|2|3|4|5|6').split('|').filter(Boolean);
              const checked = days.includes(String(idx));
              const isLastChecked = checked && days.length <= 1;
              return (
                <label key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: isLastChecked ? 'not-allowed' : 'pointer', opacity: isLastChecked ? 0.5 : 1 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isLastChecked}
                    onChange={() => {
                      const newDays = checked
                        ? days.filter(d => d !== String(idx))
                        : [...days, String(idx)].sort();
                      const newValue = newDays.join('|');
                      setSettings({ ...settings, club_days: newValue });
                      saveSetting('club_days', newValue);
                    }}
                  />
                  {label}
                </label>
              );
            })}
          </div>
          <small style={{ color: '#6b7280' }}>Days of the week the club operates. At least one must be selected.</small>
          {saved === 'club_days' && <small style={{ color: '#10b981', marginLeft: '0.5rem' }}>✓ Saved</small>}
        </div>
      </div>
    </div>
  );
}
