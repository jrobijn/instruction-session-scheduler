import { useEffect } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useTheme, ThemeProvider } from './ThemeContext';
import { useT, getLocale, setLocale, getAvailableLocales } from './i18n';
import LoginPage from './pages/LoginPage';
import StudentsPage from './pages/StudentsPage';
import InstructorsPage from './pages/InstructorsPage';
import SessionsPage from './pages/SessionsPage';
import SessionDetailPage from './pages/SessionDetailPage';
import TimetablesPage from './pages/TimetablesPage';
import TimetableDetailPage from './pages/TimetableDetailPage';
import SettingsPage from './pages/SettingsPage';
import DisciplinesPage from './pages/DisciplinesPage';
import GroupsPage from './pages/GroupsPage';
import GroupDetailPage from './pages/GroupDetailPage';
import InvitationPage from './pages/InvitationPage';
import NotificationsPage from './pages/NotificationsPage';
import NotificationBell from './components/NotificationBell';
import Logo from './components/Logo';
import { Globe, LogOut, Sun } from 'lucide-react';
import { Button } from './ui';
import { cx } from './ui/cx';
import styles from './App.module.css';

const navLinkClass = ({ isActive }: { isActive: boolean }) => cx(styles.link, isActive && styles.active);

function AdminLayout() {
  const navigate = useNavigate();
  const { authenticated, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const t = useT();

  useEffect(() => { document.title = t.appTitle; }, [t.appTitle]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  if (!authenticated) return <Navigate to="/login" />;

  return (
    <div className={styles.shell}>
      <nav className={styles.nav}>
        <NavLink to="/sessions" className={styles.brand}>
          <Logo className={styles.brandLogo} />
          <span className={styles.brandTitle}>{t.appTitle}</span>
        </NavLink>
        <div className={styles.links}>
          <NavLink to="/sessions" className={navLinkClass}>{t.navSchedule}</NavLink>
          <NavLink to="/timetables" className={navLinkClass}>{t.navTimetables}</NavLink>
          <NavLink to="/students" className={navLinkClass}>{t.navStudents}</NavLink>
          <NavLink to="/instructors" className={navLinkClass}>{t.navInstructors}</NavLink>
          <NavLink to="/disciplines" className={navLinkClass}>{t.navDisciplines}</NavLink>
          <NavLink to="/groups" className={navLinkClass}>{t.navGroups}</NavLink>
          <NavLink to="/settings" className={navLinkClass}>{t.navSettings}</NavLink>
        </div>
        <div className={styles.spacer} />
        <div className={styles.tools}>
          <NotificationBell />
          <span className={styles.selectWrap}>
            <Sun className={styles.selectIcon} aria-hidden />
            <select
              className={styles.select}
              value={mode}
              onChange={e => setMode(e.target.value as 'light' | 'dark' | 'auto')}
            >
              <option value="light">{t.themeLight}</option>
              <option value="dark">{t.themeDark}</option>
              <option value="auto">{t.themeAuto}</option>
            </select>
          </span>
          <span className={styles.selectWrap}>
            <Globe className={styles.selectIcon} aria-hidden />
            <select
              className={styles.select}
              value={getLocale()}
              onChange={e => setLocale(e.target.value)}
            >
              {getAvailableLocales().map(code => (
                <option key={code} value={code}>{t.languageNames[code] || code}</option>
              ))}
            </select>
          </span>
          <Button variant="ghost" size="sm" icon={<LogOut />} onClick={handleLogout} aria-label={t.logout}>
            <span className={styles.hideNarrow}>{t.logout}</span>
          </Button>
        </div>
      </nav>
      <Routes>
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/instructors" element={<InstructorsPage />} />
        <Route path="/disciplines" element={<DisciplinesPage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/groups/:id" element={<GroupDetailPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/timetables" element={<TimetablesPage />} />
        <Route path="/timetables/:id" element={<TimetableDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="*" element={<Navigate to="/sessions" />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invitation/:token" element={<InvitationPage />} />
        <Route path="/*" element={<AdminLayout />} />
      </Routes>
    </ThemeProvider>
  );
}
