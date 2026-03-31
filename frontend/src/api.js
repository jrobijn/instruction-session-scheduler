const API_BASE = 'http://localhost:3001/api';

function getToken() {
  return localStorage.getItem('admin_token');
}

export function setToken(token) {
  localStorage.setItem('admin_token', token);
}

export function clearToken() {
  localStorage.removeItem('admin_token');
}

export function isAuthenticated() {
  return !!getToken();
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  // Auth
  login: (password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),

  // Students
  getStudents: () => request('/students'),
  getStudent: (id) => request(`/students/${id}`),
  createStudent: (data) => request('/students', { method: 'POST', body: JSON.stringify(data) }),
  updateStudent: (id, data) => request(`/students/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteStudent: (id) => request(`/students/${id}`, { method: 'DELETE' }),

  // Instructors
  getInstructors: () => request('/instructors'),
  getInstructor: (id) => request(`/instructors/${id}`),
  createInstructor: (data) => request('/instructors', { method: 'POST', body: JSON.stringify(data) }),
  updateInstructor: (id, data) => request(`/instructors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteInstructor: (id) => request(`/instructors/${id}`, { method: 'DELETE' }),

  // Evenings
  getEvenings: () => request('/evenings'),
  getEvening: (id) => request(`/evenings/${id}`),
  createEvening: (data) => request('/evenings', { method: 'POST', body: JSON.stringify(data) }),
  updateEvening: (id, data) => request(`/evenings/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEvening: (id) => request(`/evenings/${id}`, { method: 'DELETE' }),
  assignInstructor: (eveningId, instructorId) => request(`/evenings/${eveningId}/instructors`, { method: 'POST', body: JSON.stringify({ instructor_id: instructorId }) }),
  removeInstructor: (eveningId, instructorId) => request(`/evenings/${eveningId}/instructors/${instructorId}`, { method: 'DELETE' }),
  generateSchedule: (eveningId) => request(`/evenings/${eveningId}/generate-schedule`, { method: 'POST' }),
  sendInvitations: (eveningId) => request(`/evenings/${eveningId}/send-invitations`, { method: 'POST' }),
  completeEvening: (eveningId) => request(`/evenings/${eveningId}/complete`, { method: 'POST' }),

  // Settings
  getSettings: () => request('/settings'),
  updateSetting: (key, value) => request(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

  // Public invitation
  getInvitation: (token) => request(`/invitations/${token}`),
  confirmInvitation: (token) => request(`/invitations/${token}/confirm`, { method: 'POST' }),
  declineInvitation: (token) => request(`/invitations/${token}/decline`, { method: 'POST' }),
};
