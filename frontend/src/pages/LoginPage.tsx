import { useState, useEffect, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import { useT } from '../i18n';
import { LogIn } from 'lucide-react';
import { Alert, Button, Card, CenteredPage, Field, Input, Stack, Text } from '../ui';
import Logo from '../components/Logo';
import styles from './LoginPage.module.css';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const { login } = useAuth();
  const navigate = useNavigate();
  const t = useT();

  useEffect(() => {
    api.checkAuth()
      .then(() => navigate('/sessions', { replace: true }))
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(password);
      navigate('/sessions');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (checking) return null;

  return (
    <CenteredPage>
      <Card className={styles.card}>
        <Stack gap={6}>
          <Stack gap={3} align="center">
            <Logo className={styles.logo} />
            <h1 className={styles.title}>{t.appTitle}</h1>
            <Text tone="muted" label>{t.adminLogin}</Text>
          </Stack>
          <form onSubmit={handleSubmit}>
            <Stack gap={4}>
              {error && <Alert tone="danger">{error}</Alert>}
              <Field label={t.password} htmlFor="login-password">
                <Input id="login-password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
              </Field>
              <Button variant="primary" type="submit" icon={<LogIn />} fullWidth disabled={loading}>
                {loading ? t.loggingIn : t.login}
              </Button>
            </Stack>
          </form>
        </Stack>
      </Card>
    </CenteredPage>
  );
}
