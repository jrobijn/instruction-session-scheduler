import { useEffect } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
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
import DisciplineDetailPage from './pages/DisciplineDetailPage';
import GroupsPage from './pages/GroupsPage';
import GroupDetailPage from './pages/GroupDetailPage';
import BuddyGroupsPage from './pages/BuddyGroupsPage';
import BuddyGroupDetailPage from './pages/BuddyGroupDetailPage';
import InvitationPage from './pages/InvitationPage';

function AdminLayout() {
  const navigate = useNavigate();
  const { authenticated, logout } = useAuth();
  const t = useT();

  useEffect(() => { document.title = t.appTitle; }, [t.appTitle]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  if (!authenticated) return <Navigate to="/login" />;

  return (
    <div className="app">
      <nav>
        <NavLink to="/sessions" className="logo" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img src="/logo.png" alt="Logo" style={{ height: 28, width: 'auto', objectFit: 'contain' }} />
          {t.appTitle}
        </NavLink>
        <NavLink to="/sessions">{t.navSchedule}</NavLink>
        <NavLink to="/timetables">{t.navTimetables}</NavLink>
        <NavLink to="/students">{t.navStudents}</NavLink>
        <NavLink to="/instructors">{t.navInstructors}</NavLink>
        <NavLink to="/disciplines">{t.navDisciplines}</NavLink>
        <NavLink to="/groups">{t.navGroups}</NavLink>
        <NavLink to="/buddy-groups">{t.navBuddyGroups}</NavLink>
        <NavLink to="/settings">{t.navSettings}</NavLink>
        <div className="spacer" />
        <div className="locale-wrapper">
          <svg className="locale-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          <select
            className="locale-select"
            value={getLocale()}
            onChange={e => setLocale(e.target.value)}
          >
            {getAvailableLocales().map(code => (
              <option key={code} value={code}>{t.languageNames[code] || code}</option>
            ))}
          </select>
        </div>
        <button className="logout-btn" onClick={handleLogout}>{t.logout}</button>
      </nav>
      <Routes>
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/instructors" element={<InstructorsPage />} />
        <Route path="/disciplines" element={<DisciplinesPage />} />
        <Route path="/disciplines/:id" element={<DisciplineDetailPage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/groups/:id" element={<GroupDetailPage />} />
        <Route path="/buddy-groups" element={<BuddyGroupsPage />} />
        <Route path="/buddy-groups/:id" element={<BuddyGroupDetailPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/timetables" element={<TimetablesPage />} />
        <Route path="/timetables/:id" element={<TimetableDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/sessions" />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invitation/:token" element={<InvitationPage />} />
      <Route path="/*" element={<AdminLayout />} />
    </Routes>
  );
}
