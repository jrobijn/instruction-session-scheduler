import { useState, useEffect } from 'react';
import { api } from '../api';

interface Settings {
  [key: string]: string;
}

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
      </div>
    </div>
  );
}
