import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken, isAuthenticated } from '../api';
import { useT } from '../i18n';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const t = useT();

  if (isAuthenticated()) {
    navigate('/sessions');
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.login(password);
      setToken(data.token);
      navigate('/sessions');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>{t.appTitle}</h1>
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', marginBottom: 24 }}>
          {t.adminLogin}
        </p>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t.password}</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
          </div>
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? t.loggingIn : t.login}
          </button>
        </form>
      </div>
    </div>
  );
}
