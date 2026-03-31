const API_BASE = 'http://localhost:3001/api';

function getToken(): string | null {
  return localStorage.getItem('admin_token');
}

export function setToken(token: string): void {
  localStorage.setItem('admin_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('admin_token');
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

async function request(path: string, options: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) };
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
  login: (password: string) => request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),

  // Students
  getStudents: () => request('/students'),
  getStudent: (id: number) => request(`/students/${id}`),
  createStudent: (data: { first_name: string; last_name: string; email: string }) => request('/students', { method: 'POST', body: JSON.stringify(data) }),
  updateStudent: (id: number, data: Record<string, unknown>) => request(`/students/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteStudent: (id: number) => request(`/students/${id}`, { method: 'DELETE' }),

  // Instructors
  getInstructors: () => request('/instructors'),
  getInstructor: (id: number) => request(`/instructors/${id}`),
  createInstructor: (data: { first_name: string; last_name: string; email: string }) => request('/instructors', { method: 'POST', body: JSON.stringify(data) }),
  updateInstructor: (id: number, data: Record<string, unknown>) => request(`/instructors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteInstructor: (id: number) => request(`/instructors/${id}`, { method: 'DELETE' }),

  // Evenings
  getEvenings: () => request('/evenings'),
  getEvening: (id: string) => request(`/evenings/${id}`),
  createEvening: (data: { date: string; notes?: string }) => request('/evenings', { method: 'POST', body: JSON.stringify(data) }),
  updateEvening: (id: string, data: Record<string, unknown>) => request(`/evenings/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEvening: (id: number) => request(`/evenings/${id}`, { method: 'DELETE' }),
  assignInstructor: (eveningId: string, instructorId: string) => request(`/evenings/${eveningId}/instructors`, { method: 'POST', body: JSON.stringify({ instructor_id: instructorId }) }),
  removeInstructor: (eveningId: string, instructorId: number) => request(`/evenings/${eveningId}/instructors/${instructorId}`, { method: 'DELETE' }),
  addTimeslot: (eveningId: number, startTime: string) => request(`/evenings/${eveningId}/timeslots`, { method: 'POST', body: JSON.stringify({ start_time: startTime }) }),
  deleteTimeslot: (eveningId: number, timeslotId: number) => request(`/evenings/${eveningId}/timeslots/${timeslotId}`, { method: 'DELETE' }),
  generateSchedule: (eveningId: string) => request(`/evenings/${eveningId}/generate-schedule`, { method: 'POST' }),
  sendInvitations: (eveningId: string) => request(`/evenings/${eveningId}/send-invitations`, { method: 'POST' }),
  completeEvening: (eveningId: string) => request(`/evenings/${eveningId}/complete`, { method: 'POST' }),

  // Settings
  getSettings: () => request('/settings'),
  updateSetting: (key: string, value: string) => request(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

  // Disciplines
  getDisciplines: () => request('/disciplines'),
  createDiscipline: (data: { name: string }) => request('/disciplines', { method: 'POST', body: JSON.stringify(data) }),
  updateDiscipline: (id: number, data: Record<string, unknown>) => request(`/disciplines/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDiscipline: (id: number) => request(`/disciplines/${id}`, { method: 'DELETE' }),

  // Public invitation
  getInvitation: (token: string) => request(`/invitations/${token}`),
  confirmInvitation: (token: string, disciplineId: string | null) => request(`/invitations/${token}/confirm`, { method: 'POST', body: JSON.stringify({ discipline_id: disciplineId }) }),
  declineInvitation: (token: string) => request(`/invitations/${token}/decline`, { method: 'POST' }),

  // Public disciplines (no auth)
  getPublicDisciplines: () => request('/public/disciplines'),
};
