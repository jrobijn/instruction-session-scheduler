import { useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { isAuthenticated, clearToken } from './api';
import { useT } from './i18n';
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
  const [, forceUpdate] = useState(0);
  const t = useT();

  const handleLogout = () => {
    clearToken();
    forceUpdate(n => n + 1);
    navigate('/login');
  };

  if (!isAuthenticated()) return <Navigate to="/login" />;

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
