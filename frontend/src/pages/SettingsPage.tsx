import { useState, useEffect } from 'react';
import { api } from '../api';
import { useT, getLocale, setLocale, getAvailableLocales } from '../i18n';

interface Settings {
  [key: string]: string;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState('');
  const t = useT();

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

  if (loading) return <div className="page"><p>{t.loading}</p></div>;

  const settingsConfig = [
    { key: 'club_name', label: t.settingClubName, type: 'text', description: t.settingClubNameDesc },
    { key: 'invitation_email_subject', label: t.settingEmailSubject, type: 'text', description: t.settingEmailSubjectDesc },
    { key: 'invitation_expiry_minutes', label: t.settingExpiryMinutes, type: 'number', description: t.settingExpiryMinutesDesc },
    { key: 'invitation_check_interval_minutes', label: t.settingCheckInterval, type: 'number', description: t.settingCheckIntervalDesc },
  ];

  return (
    <div className="page">
      <h1>{t.settingsTitle}</h1>
      <div className="card">
        <div className="form-group">
          <label>{t.settingLanguage}</label>
          <select
            value={getLocale()}
            onChange={e => setLocale(e.target.value)}
          >
            {getAvailableLocales().map(code => (
              <option key={code} value={code}>{t.languageNames[code] || code}</option>
            ))}
          </select>
          <small style={{ color: '#6b7280' }}>{t.settingLanguageDesc}</small>
        </div>

        <div className="form-group">
          <label>{t.settingEmailLocale}</label>
          <select
            value={settings.email_locale || 'en'}
            onChange={e => {
              setSettings({ ...settings, email_locale: e.target.value });
              saveSetting('email_locale', e.target.value);
            }}
          >
            {getAvailableLocales().map(code => (
              <option key={code} value={code}>{t.languageNames[code] || code}</option>
            ))}
          </select>
          <small style={{ color: '#6b7280' }}>{t.settingEmailLocaleDesc}</small>
          {saved === 'email_locale' && <small style={{ color: '#10b981', marginLeft: '0.5rem' }}>{t.saved}</small>}
        </div>

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
            {saved === key && <small style={{ color: '#10b981', marginLeft: '0.5rem' }}>{t.saved}</small>}
          </div>
        ))}

        <div className="form-group">
          <label>{t.settingClubDays}</label>
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
            <small style={{ color: '#6b7280' }}>{t.settingClubDaysDesc}</small>
            {saved === 'club_days' && <small style={{ color: '#10b981', marginLeft: '0.5rem' }}>{t.saved}</small>}
        </div>
      </div>
    </div>
  );
}
