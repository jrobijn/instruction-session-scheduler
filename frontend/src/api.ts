const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001/api';

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

async function requestCsv(path: string): Promise<string> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Request failed');
  }
  return res.text();
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
  exportStudentsCsv: () => requestCsv('/students/export'),
  importStudentsCsv: (csv: string) => request('/students/import', { method: 'POST', body: JSON.stringify({ csv }) }),
  getStudentPreferredTimeslots: (id: number) => request(`/students/${id}/preferred-timeslots`),
  setStudentPreferredTimeslots: (studentId: number, timetableId: number, timeslotIds: number[]) => request(`/students/${studentId}/preferred-timeslots/${timetableId}`, { method: 'PUT', body: JSON.stringify({ timeslot_ids: timeslotIds }) }),
  setStudentCooldown: (id: number, days: number) => request(`/students/${id}/cooldown`, { method: 'PUT', body: JSON.stringify({ days }) }),
  clearStudentCooldown: (id: number) => request(`/students/${id}/cooldown`, { method: 'DELETE' }),
  bulkUpdatePriorities: (updates: Array<{ id: number; priority: number }>) => request('/students/priorities', { method: 'PUT', body: JSON.stringify({ updates }) }),

  // Instructors
  getInstructors: () => request('/instructors'),
  getInstructor: (id: number) => request(`/instructors/${id}`),
  createInstructor: (data: { first_name: string; last_name: string; email: string }) => request('/instructors', { method: 'POST', body: JSON.stringify(data) }),
  updateInstructor: (id: number, data: Record<string, unknown>) => request(`/instructors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteInstructor: (id: number) => request(`/instructors/${id}`, { method: 'DELETE' }),
  exportInstructorsCsv: () => requestCsv('/instructors/export'),
  importInstructorsCsv: (csv: string) => request('/instructors/import', { method: 'POST', body: JSON.stringify({ csv }) }),

  // Sessions
  getSessions: () => request('/sessions'),
  getSession: (id: string) => request(`/sessions/${id}`),
  createSession: (data: { date: string; notes?: string; timetable_id?: number }) => request('/sessions', { method: 'POST', body: JSON.stringify(data) }),
  updateSession: (id: string, data: Record<string, unknown>) => request(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSession: (id: number) => request(`/sessions/${id}`, { method: 'DELETE' }),
  assignInstructor: (sessionId: string, instructorId: string) => request(`/sessions/${sessionId}/instructors`, { method: 'POST', body: JSON.stringify({ instructor_id: instructorId }) }),
  removeInstructor: (sessionId: string, instructorId: number) => request(`/sessions/${sessionId}/instructors/${instructorId}`, { method: 'DELETE' }),
  generateSchedule: (sessionId: string) => request(`/sessions/${sessionId}/generate-schedule`, { method: 'POST' }),
  sendInvitations: (sessionId: string) => request(`/sessions/${sessionId}/send-invitations`, { method: 'POST' }),
  completeSession: (sessionId: string) => request(`/sessions/${sessionId}/complete`, { method: 'POST' }),
  toggleNoShow: (sessionId: number, invitationId: number) => request(`/sessions/${sessionId}/invitations/${invitationId}/toggle-no-show`, { method: 'POST' }),
  searchAvailableStudents: (sessionId: number, q: string) => request(`/sessions/${sessionId}/available-students?q=${encodeURIComponent(q)}`),
  addSessionInvitation: (sessionId: number, data: { student_id: number; timeslot_id: number; instructor_id: number }) => request(`/sessions/${sessionId}/invitations`, { method: 'POST', body: JSON.stringify(data) }),
  removeSessionInvitation: (sessionId: number, invitationId: number) => request(`/sessions/${sessionId}/invitations/${invitationId}`, { method: 'DELETE' }),

  // Timetables
  getTimetables: () => request('/timetables'),
  getTimetable: (id: number) => request(`/timetables/${id}`),
  createTimetable: (data: { name: string }) => request('/timetables', { method: 'POST', body: JSON.stringify(data) }),
  updateTimetable: (id: number, data: Record<string, unknown>) => request(`/timetables/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  saveTimetable: (id: number) => request(`/timetables/${id}/save`, { method: 'POST' }),
  setDefaultTimetable: (id: number) => request(`/timetables/${id}/set-default`, { method: 'POST' }),
  toggleTimetableActive: (id: number) => request(`/timetables/${id}/toggle-active`, { method: 'POST' }),
  deleteTimetable: (id: number) => request(`/timetables/${id}`, { method: 'DELETE' }),
  addTimetableTimeslot: (timetableId: number, startTime: string) => request(`/timetables/${timetableId}/timeslots`, { method: 'POST', body: JSON.stringify({ start_time: startTime }) }),
  deleteTimetableTimeslot: (timetableId: number, timeslotId: number) => request(`/timetables/${timetableId}/timeslots/${timeslotId}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => request('/settings'),
  updateSetting: (key: string, value: string) => request(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

  // Disciplines
  getDisciplines: () => request('/disciplines'),
  createDiscipline: (data: { name: string }) => request('/disciplines', { method: 'POST', body: JSON.stringify(data) }),
  updateDiscipline: (id: number, data: Record<string, unknown>) => request(`/disciplines/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDiscipline: (id: number) => request(`/disciplines/${id}`, { method: 'DELETE' }),
  exportDisciplinesCsv: () => requestCsv('/disciplines/export'),
  importDisciplinesCsv: (csv: string) => request('/disciplines/import', { method: 'POST', body: JSON.stringify({ csv }) }),
  setDisciplineGroups: (id: number, groupIds: number[]) => request(`/disciplines/${id}/groups`, { method: 'PUT', body: JSON.stringify({ group_ids: groupIds }) }),
  getDisciplineGroups: (id: number) => request(`/disciplines/${id}/groups`),
  addDisciplineGroup: (disciplineId: number, groupId: number) => request(`/disciplines/${disciplineId}/groups/${groupId}`, { method: 'POST' }),
  removeDisciplineGroup: (disciplineId: number, groupId: number) => request(`/disciplines/${disciplineId}/groups/${groupId}`, { method: 'DELETE' }),

  // Groups
  getGroups: () => request('/groups'),
  createGroup: (data: { name: string; priority: number; color?: string }) => request('/groups', { method: 'POST', body: JSON.stringify(data) }),
  updateGroup: (id: number, data: Record<string, unknown>) => request(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGroup: (id: number) => request(`/groups/${id}`, { method: 'DELETE' }),
  exportGroupsCsv: () => requestCsv('/groups/export'),
  importGroupsCsv: (csv: string) => request('/groups/import', { method: 'POST', body: JSON.stringify({ csv }) }),
  getGroupMembers: (id: number) => request(`/groups/${id}/members`),
  addGroupMember: (groupId: number, studentId: number) => request(`/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ student_id: studentId }) }),
  removeGroupMember: (groupId: number, studentId: number) => request(`/groups/${groupId}/members/${studentId}`, { method: 'DELETE' }),
  searchGroupNonMembers: (groupId: number, query: string) => request(`/groups/${groupId}/non-members?q=${encodeURIComponent(query)}`),

  // Student groups
  getStudentGroups: (id: number) => request(`/students/${id}/groups`),
  setStudentGroups: (id: number, groupIds: number[]) => request(`/students/${id}/groups`, { method: 'PUT', body: JSON.stringify({ group_ids: groupIds }) }),

  // Buddy groups
  getBuddyGroups: () => request('/buddy-groups'),
  createBuddyGroup: (data: { name: string }) => request('/buddy-groups', { method: 'POST', body: JSON.stringify(data) }),
  updateBuddyGroup: (id: number, data: { name: string }) => request(`/buddy-groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBuddyGroup: (id: number) => request(`/buddy-groups/${id}`, { method: 'DELETE' }),
  getBuddyGroupMembers: (id: number) => request(`/buddy-groups/${id}/members`),
  addBuddyGroupMember: (groupId: number, studentId: number) => request(`/buddy-groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ student_id: studentId }) }),
  removeBuddyGroupMember: (groupId: number, studentId: number) => request(`/buddy-groups/${groupId}/members/${studentId}`, { method: 'DELETE' }),
  searchBuddyGroupNonMembers: (groupId: number, query: string) => request(`/buddy-groups/${groupId}/non-members?q=${encodeURIComponent(query)}`),

  // Timetable groups
  setTimetableGroups: (id: number, groups: Array<{ group_id: number; percentage: number }>) => request(`/timetables/${id}/groups`, { method: 'PUT', body: JSON.stringify({ groups }) }),

  // Public invitation
  getInvitation: (token: string) => request(`/invitations/${token}`),
  confirmInvitation: (token: string, disciplineId: string | null) => request(`/invitations/${token}/confirm`, { method: 'POST', body: JSON.stringify({ discipline_id: disciplineId }) }),
  declineInvitation: (token: string) => request(`/invitations/${token}/decline`, { method: 'POST' }),
  cancelInvitation: (token: string) => request(`/invitations/${token}/cancel`, { method: 'POST' }),

  // Public disciplines (no auth)
  getPublicDisciplines: () => request('/public/disciplines'),
  getPublicDisciplinesForToken: (token: string) => request(`/public/disciplines/${token}`),
};
