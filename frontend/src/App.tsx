import { useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { isAuthenticated, clearToken } from './api';
import LoginPage from './pages/LoginPage';
import StudentsPage from './pages/StudentsPage';
import InstructorsPage from './pages/InstructorsPage';
import EveningsPage from './pages/EveningsPage';
import EveningDetailPage from './pages/EveningDetailPage';
import SettingsPage from './pages/SettingsPage';
import DisciplinesPage from './pages/DisciplinesPage';
import InvitationPage from './pages/InvitationPage';

function AdminLayout() {
  const navigate = useNavigate();
  const [, forceUpdate] = useState(0);

  const handleLogout = () => {
    clearToken();
    forceUpdate(n => n + 1);
    navigate('/login');
  };

  if (!isAuthenticated()) return <Navigate to="/login" />;

  return (
    <div className="app">
      <nav>
        <NavLink to="/evenings" className="logo">Session Scheduler</NavLink>
        <NavLink to="/evenings">Schedule</NavLink>
        <NavLink to="/students">Students</NavLink>
        <NavLink to="/instructors">Instructors</NavLink>
        <NavLink to="/disciplines">Disciplines</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <div className="spacer" />
        <button className="logout-btn" onClick={handleLogout}>Logout</button>
      </nav>
      <Routes>
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/instructors" element={<InstructorsPage />} />
        <Route path="/disciplines" element={<DisciplinesPage />} />
        <Route path="/evenings" element={<EveningsPage />} />
        <Route path="/evenings/:id" element={<EveningDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/evenings" />} />
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
