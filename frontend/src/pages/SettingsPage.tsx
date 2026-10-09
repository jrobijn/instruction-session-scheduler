import { useState, useEffect, type ReactNode } from 'react';
import { api } from '../api';
import { useT, getAvailableLocales } from '../i18n';
import { Badge, Card, Checkbox, Field, Input, Page, PageHeader, Row, Select, Stack, Text, useToast } from '../ui';

interface Settings {
  [key: string]: string;
}

// Intl.supportedValuesOf is ES2022; the frontend targets ES2020 libs.
const TIME_ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ?? [];


export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState('');
  const t = useT();
  const toast = useToast();

  const load = async () => {
    try {
      setSettings(await api.getSettings());
    } catch (err: any) {
      toast(err.message);
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
      toast(err.message);
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;

  const settingsConfig = [
    { key: 'club_name', label: t.settingClubName, type: 'text', description: t.settingClubNameDesc },
    { key: 'invitation_expiry_minutes', label: t.settingExpiryMinutes, type: 'number', description: t.settingExpiryMinutesDesc },
  ];

  const hint = (key: string, description: ReactNode) => (
    <Row gap={2}>
      <span>{description}</span>
      {saved === key && <Badge tone="success">{t.saved}</Badge>}
    </Row>
  );

  const clubDays = (settings.club_days || '0|1|2|3|4|5|6').split('|').filter(Boolean);

  return (
    <Page>
      <PageHeader title={t.settingsTitle} />
      <Card>
        <Stack gap={4}>
          <Field split label={t.settingEmailLocale} htmlFor="setting-email-locale" hint={hint('email_locale', t.settingEmailLocaleDesc)}>
            <Select
              id="setting-email-locale"
              value={settings.email_locale || 'en'}
              onChange={e => {
                setSettings({ ...settings, email_locale: e.target.value });
                saveSetting('email_locale', e.target.value);
              }}
            >
              {getAvailableLocales().map(code => (
                <option key={code} value={code}>{t.languageNames[code] || code}</option>
              ))}
            </Select>
          </Field>

          {settingsConfig.map(({ key, label, type, description }) => (
            <Field split key={key} label={label} htmlFor={`setting-${key}`} hint={hint(key, description)}>
              <Input
                id={`setting-${key}`}
                type={type}
                value={settings[key] || ''}
                onChange={e => setSettings({ ...settings, [key]: e.target.value })}
                onBlur={e => saveSetting(key, e.target.value)}
              />
            </Field>
          ))}

          <Field split label={t.settingClubDays} hint={hint('club_days', t.settingClubDaysDesc)}>
            <Row gap={4} wrap>
              {[0, 1, 2, 3, 4, 5, 6].map(idx => {
                const checked = clubDays.includes(String(idx));
                return (
                  <Checkbox
                    key={idx}
                    label={t.days[idx]}
                    checked={checked}
                    disabled={checked && clubDays.length <= 1}
                    onCheckedChange={() => {
                      const newDays = checked
                        ? clubDays.filter(d => d !== String(idx))
                        : [...clubDays, String(idx)].sort();
                      const newValue = newDays.join('|');
                      setSettings({ ...settings, club_days: newValue });
                      saveSetting('club_days', newValue);
                    }}
                  />
                );
              })}
            </Row>
          </Field>

          <Field split label={t.settingTimezone} htmlFor="setting-timezone" hint={hint('timezone', t.settingTimezoneDesc)}>
            <Select
              id="setting-timezone"
              value={settings.timezone || 'Europe/Amsterdam'}
              onChange={e => {
                setSettings({ ...settings, timezone: e.target.value });
                saveSetting('timezone', e.target.value);
              }}
            >
              {[...new Set([settings.timezone || 'Europe/Amsterdam', ...TIME_ZONES])].sort().map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </Select>
          </Field>
        </Stack>
      </Card>
    </Page>
  );
}
