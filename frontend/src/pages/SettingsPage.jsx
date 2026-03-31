import { useState, useEffect } from 'react';
import { api } from '../api.js';

export default function SettingsPage() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then(s => { setSettings(s); setLoading(false); });
  }, []);

  const handleSave = async (key, value) => {
    await api.updateSetting(key, value);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return <div className="page"><p>Loading...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      {saved && <div className="alert alert-success">Setting saved!</div>}

      <div className="card">
        <div className="form-group">
          <label>Club Name</label>
          <input
            value={settings.club_name || ''}
            onChange={e => setSettings({ ...settings, club_name: e.target.value })}
            onBlur={e => handleSave('club_name', e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Coaching Sessions per Instructor</label>
          <input
            type="number"
            min="1"
            max="20"
            value={settings.sessions_per_instructor || '3'}
            onChange={e => setSettings({ ...settings, sessions_per_instructor: e.target.value })}
            onBlur={e => handleSave('sessions_per_instructor', e.target.value)}
          />
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            The number of students each instructor can coach per evening. Total invitations = instructors × this number.
          </p>
        </div>

        <div className="form-group">
          <label>Invitation Email Subject</label>
          <input
            value={settings.invitation_email_subject || ''}
            onChange={e => setSettings({ ...settings, invitation_email_subject: e.target.value })}
            onBlur={e => handleSave('invitation_email_subject', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
