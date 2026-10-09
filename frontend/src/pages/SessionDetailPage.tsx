import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight, Ban, CircleCheck, ExternalLink, FileDown, Plus, RefreshCw, RotateCcw, Send,
  Sparkles, Timer, UserCheck, UserPlus, UserX, Users, Wand2, X,
} from 'lucide-react';
import { api, API_BASE } from '../api';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { useT, getLocale } from '../i18n';
import {
  Alert, Badge, Button, Card, Checkbox, Chip, Input, Page, PageHeader, Popover, Row, Select, Stack, Table, Text, Tooltip,
  useConfirm, useToast,
} from '../ui';
import Countdown from '../components/Countdown';
import DecisionLog from '../components/DecisionLog';
import { AllocationBar } from '../components/AllocationBar';
import { InvitationStatusBadge, SessionStatusBadge } from '../components/StatusBadges';
import { StudentSearchResults } from '../components/StudentSearchResults';
import styles from './SessionDetailPage.module.css';
import buddyStyles from '../components/BuddyRows.module.css';

interface Instructor {
  id: number;
  first_name: string;
  last_name: string;
}

interface Timeslot {
  id: number;
  timetable_id: number;
  start_time: string;
}

interface TimetableInfo {
  id: number;
  name: string;
  status: string;
  active: number;
}

interface Invitation {
  id: number;
  student_id: number;
  student_name: string;
  student_email: string;
  student_membership_id: string;
  instructor_id: number;
  instructor_name: string;
  discipline_name: string | null;
  discipline_abbreviation: string | null;
  status: string;
  token: string;
  timeslot_id: number;
  timeslot_start_time: string;
  no_show: number;
  group_name: string | null;
  group_color: string | null;
  invited_at: string | null;
  expires_at: string | null;
  buddy_group_id: number | null;
  buddy_group_name: string | null;
  decision_log: string | null;
}

interface TimetableGroup {
  group_id: number;
  percentage: number;
  group_name: string;
  group_color: string;
  is_default: number;
}

interface SessionDetail {
  id: number;
  date: string;
  status: string;
  timetable_id: number | null;
  timetable: TimetableInfo | null;
  instructors: Instructor[];
  timeslots: Timeslot[];
  invitations: Invitation[];
  timetableGroups: TimetableGroup[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(getLocale() === 'nl' ? 'nl-NL' : 'en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

const INACTIVE_STATUSES = ['declined', 'expired', 'invalidated', 'cancelled', 'admin_cancelled'];

interface InstructorPickerProps {
  title?: string;
  query: string;
  onQueryChange: (query: string) => void;
  emptyText?: string;
  children: ReactNode;
}

/** Search field + scrollable list, shared by the add and replace instructor popovers. */
function InstructorPicker({ title, query, onQueryChange, emptyText, children }: InstructorPickerProps) {
  const t = useT();
  return (
    <>
      <div className={styles.instructorSearch}>
        <Stack gap={2}>
          {title && <Text label>{title}</Text>}
          <Input
            type="search"
            aria-label={t.searchInstructors}
            placeholder={t.searchInstructors}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
          />
        </Stack>
      </div>
      <div className={styles.instructorList}>
        {emptyText ? <div className={styles.instructorEmpty}><Text tone="muted" size="sm">{emptyText}</Text></div> : children}
      </div>
    </>
  );
}

// jsPDF can't read CSS variables; these mirror the light theme in styles/tokens.css
const PDF_COLORS = {
  text: [29, 33, 36] as [number, number, number],
  muted: [93, 101, 107] as [number, number, number],
  rule: [169, 175, 180] as [number, number, number],
  headerFill: [223, 226, 228] as [number, number, number],
  accent: [232, 89, 12] as [number, number, number],
};

export default function SessionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [allInstructors, setAllInstructors] = useState<Instructor[]>([]);
  const [allTimetables, setAllTimetables] = useState<TimetableInfo[]>([]);
  const [clubName, setClubName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [addSlot, setAddSlot] = useState<{ timeslotId: number; instructorId: number } | null>(null);
  const [studentSearch, setStudentSearch] = useState('');
  const [studentResults, setStudentResults] = useState<Array<{ id: number; first_name: string; last_name: string; email: string }>>([]);
  const [showStudentDropdown, setShowStudentDropdown] = useState(false);
  const [dropdownUp, setDropdownUp] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement | null>(null);
  const [replacingInstructorId, setReplacingInstructorId] = useState<number | null>(null);
  const [instructorQuery, setInstructorQuery] = useState('');
  const [pendingInstructorId, setPendingInstructorId] = useState<number | null>(null);
  const focusInstructorAfterLoad = useRef<number | null>(null);

  useEffect(() => {
    if (focusInstructorAfterLoad.current === null) return;
    document.querySelector<HTMLElement>(`[data-instructor-id="${focusInstructorAfterLoad.current}"] button`)?.focus();
    focusInstructorAfterLoad.current = null;
  }, [session]);

  useEffect(() => {
    const img = new Image();
    img.src = '/logo.png';
    img.onload = () => { logoRef.current = img; };
  }, []);

  const load = async () => {
    try {
      const [sess, instr, tts, settings] = await Promise.all([
        api.getSession(Number(id)),
        api.getInstructors(),
        api.getTimetables(),
        api.getSettings(),
      ]);
      setSession(sess);
      setAllInstructors(instr);
      setClubName(settings.club_name || '');
      // Only saved + active timetables for selection
      setAllTimetables(tts.filter((t: any) => t.status === 'saved' && t.active));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  // SSE: real-time updates
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`${API_BASE}/sessions/${id}/events`, { withCredentials: true });

    es.addEventListener('invitation_updated', (e) => {
      const data = JSON.parse(e.data);
      setSession(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          invitations: prev.invitations.map(inv =>
            inv.id === data.id ? { ...inv, ...data } : inv
          ),
        };
      });
    });

    es.addEventListener('invitation_added', (e) => {
      const data = JSON.parse(e.data);
      setSession(prev => {
        if (!prev) return prev;
        return { ...prev, invitations: [...prev.invitations, data] };
      });
    });

    es.addEventListener('session_updated', (e) => {
      const data = JSON.parse(e.data);
      setSession(prev => prev ? { ...prev, ...data } : prev);
    });

    es.addEventListener('reload', () => { load(); });

    return () => es.close();
  }, [id]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowStudentDropdown(false);
        setAddSlot(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const searchStudents = (query: string) => {
    setStudentSearch(query);
    clearTimeout(searchTimeout.current);
    if (query.trim().length < 2) { setStudentResults([]); setShowStudentDropdown(false); return; }
    searchTimeout.current = setTimeout(async () => {
      try {
        const results = await api.searchAvailableStudents(Number(id), query.trim());
        setStudentResults(results);
        setShowStudentDropdown(results.length > 0);
        if (results.length > 0 && dropdownRef.current) {
          const rect = dropdownRef.current.getBoundingClientRect();
          setDropdownUp(window.innerHeight - rect.bottom < 220);
        }
      } catch { setStudentResults([]); }
    }, 300);
  };

  const addStudentToSlot = async (studentId: number) => {
    if (!addSlot) return;
    if (session?.status === 'invitations_sent') {
      if (!await confirm({ title: t.addStudentToSlot, message: t.confirmAddAndInvite })) return;
    }
    try {
      await api.addSessionInvitation(Number(id), {
        student_id: studentId,
        timeslot_id: addSlot.timeslotId,
        instructor_id: addSlot.instructorId,
      });
      setAddSlot(null);
      setStudentSearch('');
      setStudentResults([]);
      setShowStudentDropdown(false);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const removeInvitation = async (invitationId: number) => {
    try {
      await api.removeSessionInvitation(Number(id), invitationId);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const removeInstructor = async (instructorId: number) => {
    // Count active invitations that will be cancelled for this instructor
    const activeInvs = session?.invitations.filter(
      inv => inv.instructor_id === instructorId &&
        inv.status !== 'declined' && inv.status !== 'expired' && inv.status !== 'invalidated' &&
        inv.status !== 'cancelled' && inv.status !== 'admin_cancelled'
    ) || [];
    const sentInvs = activeInvs.filter(inv => inv.status === 'invited' || inv.status === 'confirmed');
    if (sentInvs.length > 0) {
      if (!await confirm({ title: t.remove, message: t.confirmRemoveInstructor(sentInvs.length), confirmLabel: t.remove, danger: true })) return;
    }
    try {
      await api.removeInstructor(Number(id), instructorId);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const replaceInstructor = async (oldInstructorId: number, newInstructorId: number) => {
    setPendingInstructorId(oldInstructorId);
    try {
      await api.replaceInstructor(Number(id), oldInstructorId, newInstructorId);
      setReplacingInstructorId(null);
      setInstructorQuery('');
      focusInstructorAfterLoad.current = newInstructorId;
      load();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setPendingInstructorId(null);
    }
  };

  const assignInstructor = async (instructorId: number) => {
    try {
      await api.assignInstructor(Number(id), instructorId);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const toggleInstructor = async (instructorId: number, checked: boolean) => {
    setPendingInstructorId(instructorId);
    try {
      await (checked ? assignInstructor(instructorId) : removeInstructor(instructorId));
    } finally {
      setPendingInstructorId(null);
    }
  };

  const changeTimetable = async (timetableId: string) => {
    const newTtId = timetableId ? Number(timetableId) : null;
    if (session?.status === 'scheduled') {
      if (!await confirm({ title: t.timetableSection, message: t.confirmTimetableChange })) return;
    }
    try {
      await api.updateSession(String(id), { timetable_id: newTtId });
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const generateSchedule = async () => {
    setActionLoading('generating');
    try {
      await api.generateSchedule(Number(id));
      load();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setActionLoading('');
    }
  };

  const sendInvitations = async () => {
    if (!await confirm({ title: t.sendInvitations, message: t.confirmSendInvitations, confirmLabel: t.sendInvitations })) return;
    setActionLoading('sending');
    try {
      await api.sendInvitations(Number(id));
      load();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setActionLoading('');
    }
  };

  const toggleNoShow = async (invitationId: number) => {
    try {
      await api.toggleNoShow(Number(id), invitationId);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const adminCancelInvitation = async (invitationId: number) => {
    if (!await confirm({ title: t.adminCancelInvitation, message: t.confirmAdminCancel, confirmLabel: t.adminCancelInvitation, danger: true })) return;
    try {
      await api.adminCancelInvitation(Number(id), invitationId);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const autoScheduleSlot = async (timeslotId: number, instructorId: number) => {
    if (!await confirm({ title: t.autoScheduleLabel, message: t.confirmAutoInvite, confirmLabel: t.autoScheduleLabel })) return;
    try {
      const result = await api.autoScheduleSlot(Number(id), timeslotId, instructorId);
      if (!result.replacement) {
        toast(t.noReplacementFound, 'info');
      }
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const completeSession = async () => {
    if (!await confirm({ title: t.markCompleted, message: t.confirmComplete, confirmLabel: t.markCompleted })) return;
    setActionLoading('completing');
    try {
      await api.completeSession(Number(id));
      load();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setActionLoading('');
    }
  };

  const cancelSession = async () => {
    const activeCount = session?.invitations.filter(inv => inv.status === 'invited' || inv.status === 'confirmed').length || 0;
    if (!await confirm({ title: t.cancelSession, message: t.confirmCancelSession(activeCount), confirmLabel: t.cancelSession, danger: true })) return;
    setActionLoading('cancelling');
    try {
      await api.cancelSession(Number(id));
      load();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setActionLoading('');
    }
  };

  const reactivateSession = async () => {
    if (!await confirm({ title: t.reactivateSession, message: t.confirmReactivateSession, confirmLabel: t.reactivateSession })) return;
    setActionLoading('reactivating');
    try {
      await api.reactivateSession(Number(id));
      load();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setActionLoading('');
    }
  };

  if (loading) return <Page><Text tone="muted">{t.loading}</Text></Page>;
  if (!session) return <Page><Text tone="muted">{t.sessionNotFound}</Text></Page>;

  const assignedIds = new Set(session.instructors.map(i => i.id));
  const availableInstructors = allInstructors.filter(i => !assignedIds.has(i.id));
  const instructorFilter = instructorQuery.trim().toLowerCase();
  const matchesQuery = (i: Instructor) => `${i.first_name} ${i.last_name}`.toLowerCase().includes(instructorFilter);
  const filteredInstructors = allInstructors.filter(matchesQuery);
  const replacementCandidates = availableInstructors.filter(matchesQuery);

  const confirmed = session.invitations.filter(i => i.status === 'confirmed').length;
  const declined = session.invitations.filter(i => i.status === 'declined').length;
  const cancelled = session.invitations.filter(i => i.status === 'cancelled').length;
  const adminCancelled = session.invitations.filter(i => i.status === 'admin_cancelled').length;
  const expired = session.invitations.filter(i => i.status === 'expired').length;
  const invalidated = session.invitations.filter(i => i.status === 'invalidated').length;
  const invited = session.invitations.filter(i => i.status === 'invited').length;
  const scheduled = session.invitations.filter(i => i.status === 'scheduled').length;

  // Build schedule grid: timeslots as rows, instructors as columns
  const scheduleGrid: Record<number, Record<number, Invitation | undefined>> = {};
  for (const ts of session.timeslots) {
    scheduleGrid[ts.id] = {};
  }
  for (const inv of session.invitations) {
    if (inv.status !== 'declined' && inv.status !== 'expired' && inv.status !== 'invalidated' && inv.status !== 'cancelled' && inv.status !== 'admin_cancelled') {
      scheduleGrid[inv.timeslot_id] ??= {};
      scheduleGrid[inv.timeslot_id][inv.instructor_id] = inv;
    }
  }

  const canEdit = session.status === 'draft' || session.status === 'scheduled';

  // Build unified slot list for invitations table: every timeslot×instructor gets rows for
  // existing invitations (including declined) plus an empty add-row if the slot is unoccupied
  type SlotEntry = { timeslotId: number; instructorId: number; startTime: string; instructorName: string; invitation: Invitation | null; empty: boolean };
  type SlotGroup = { timeslotId: number; instructorId: number; startTime: string; instructorName: string; entries: SlotEntry[] };
  const slotGroups: SlotGroup[] = [];
  const assignedInstructorIds = new Set(session.instructors.map(i => i.id));
  for (const ts of session.timeslots) {
    for (const instr of session.instructors) {
      const instrName = `${instr.first_name} ${instr.last_name}`;
      const slotInvitations = session.invitations.filter(
        inv => inv.timeslot_id === ts.id && inv.instructor_id === instr.id
      );
      const entries: SlotEntry[] = [];
      // Add all invitations for this slot (active + declined)
      for (const inv of slotInvitations) {
        entries.push({ timeslotId: ts.id, instructorId: instr.id, startTime: ts.start_time, instructorName: instrName, invitation: inv, empty: false });
      }
      // If no active (non-declined/expired) invitation occupies this slot, add an empty row
      const hasActive = slotInvitations.some(inv => inv.status !== 'declined' && inv.status !== 'expired' && inv.status !== 'invalidated' && inv.status !== 'cancelled' && inv.status !== 'admin_cancelled');
      if (!hasActive) {
        entries.push({ timeslotId: ts.id, instructorId: instr.id, startTime: ts.start_time, instructorName: instrName, invitation: null, empty: true });
      }
      slotGroups.push({ timeslotId: ts.id, instructorId: instr.id, startTime: ts.start_time, instructorName: instrName, entries });
    }
  }
  // Add orphaned invitations (instructor was removed from session)
  const orphanedInvitations = session.invitations.filter(
    inv => !assignedInstructorIds.has(inv.instructor_id)
  );
  if (orphanedInvitations.length > 0) {
    // Group orphans by timeslot+instructor
    const orphanMap = new Map<string, SlotEntry[]>();
    for (const inv of orphanedInvitations) {
      const key = `${inv.timeslot_id}-${inv.instructor_id}`;
      if (!orphanMap.has(key)) orphanMap.set(key, []);
      orphanMap.get(key)!.push({ timeslotId: inv.timeslot_id, instructorId: inv.instructor_id, startTime: inv.timeslot_start_time, instructorName: inv.instructor_name, invitation: inv, empty: false });
    }
    for (const [, entries] of orphanMap) {
      const first = entries[0];
      slotGroups.push({ timeslotId: first.timeslotId, instructorId: first.instructorId, startTime: first.startTime, instructorName: first.instructorName, entries });
    }
  }

  // Buddy group indicators: assign colors to buddy groups with 2+ members in this session
  const BUDDY_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#c026d3', '#ea580c', '#4f46e5', '#059669'];
  const buddyGroupStudents = new Map<number, Set<number>>();
  for (const inv of session.invitations) {
    if (inv.buddy_group_id && inv.status !== 'declined' && inv.status !== 'expired' && inv.status !== 'invalidated' && inv.status !== 'cancelled') {
      if (!buddyGroupStudents.has(inv.buddy_group_id)) buddyGroupStudents.set(inv.buddy_group_id, new Set());
      buddyGroupStudents.get(inv.buddy_group_id)!.add(inv.student_id);
    }
  }
  const activeBuddyGroups = [...buddyGroupStudents.entries()].filter(([, s]) => s.size >= 2).map(([id]) => id);
  const buddyColorMap = new Map<number, string>();
  activeBuddyGroups.forEach((bgId, i) => buddyColorMap.set(bgId, BUDDY_COLORS[i % BUDDY_COLORS.length]));

  const exportPdf = () => {
    const doc = new jsPDF({ orientation: 'landscape' });
    const dateStr = formatDate(session.date);

    // Add logo
    if (logoRef.current) {
      try {
        doc.addImage(logoRef.current, 'PNG', 14, 10, 16, 16);
      } catch {
        // logo failed, continue without
      }
    }

    doc.setFontSize(16);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(t.pdfTitle(dateStr), 34, 22);

    // Header rule with a short accent bar, echoing the page headers in the app
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...PDF_COLORS.rule);
    doc.setLineWidth(0.2);
    doc.line(14, 28, pageWidth - 14, 28);
    doc.setFillColor(...PDF_COLORS.accent);
    doc.rect(14, 27.6, 24, 0.9, 'F');

    const locale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';
    const generatedAt = new Date().toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
    const totalPagesPlaceholder = '{total_pages_count_string}';

    const boxSize = 3.5;
    const boxPad = 2;

    // Each instructor gets 2 columns: student (with checkbox + membership ID subtitle) and discipline abbreviation
    const headerRow: any[] = [{ content: t.time, rowSpan: 2, styles: { cellPadding: 3, halign: 'left' } }];
    for (const instr of session.instructors) {
      headerRow.push({ content: `${instr.first_name} ${instr.last_name}`, colSpan: 2, styles: { halign: 'left' } });
    }
    const subHeaderRow: any[] = [];
    for (let i = 0; i < session.instructors.length; i++) {
      subHeaderRow.push({ content: t.pdfStudentColumn, styles: { fontSize: 8, fontStyle: 'normal', textColor: PDF_COLORS.muted } });
      subHeaderRow.push({ content: t.pdfDisciplineColumn, styles: { fontSize: 8, fontStyle: 'normal', textColor: PDF_COLORS.muted } });
    }

    const subtitles: Record<string, string> = {};
    const body = session.timeslots.map((ts, rowIdx) => {
      const row: string[] = [ts.start_time];
      session.instructors.forEach((instr, colIdx) => {
        const inv = scheduleGrid[ts.id]?.[instr.id];
        row.push(inv ? inv.student_name : '');
        row.push(inv?.discipline_abbreviation || '');
        if (inv?.student_membership_id) {
          const studentColIdx = 1 + colIdx * 2;
          subtitles[`${rowIdx}-${studentColIdx}`] = inv.student_membership_id;
        }
      });
      return row;
    });

    // Build columnStyles: Time col monospace, discipline cols smaller width
    const colStyles: Record<number, any> = { 0: { cellPadding: 3, halign: 'left', font: 'courier', fontStyle: 'bold' } };
    for (let i = 0; i < session.instructors.length; i++) {
      colStyles[2 + i * 2] = { cellPadding: 3, cellWidth: 18, halign: 'center' };
    }

    autoTable(doc, {
      startY: 32,
      margin: { bottom: 18 },
      head: [headerRow, subHeaderRow],
      body,
      styles: { fontSize: 10, textColor: PDF_COLORS.text, cellPadding: { top: 3, right: 3, bottom: 6, left: 8 } },
      headStyles: {
        fillColor: PDF_COLORS.headerFill,
        textColor: PDF_COLORS.text,
        fontStyle: 'bold',
        lineColor: PDF_COLORS.rule,
        lineWidth: { bottom: 0.3 },
        cellPadding: { top: 3, right: 3, bottom: 3, left: 8 },
      },
      columnStyles: colStyles,
      didDrawPage: (data: any) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(...PDF_COLORS.muted);
        const footerY = pageHeight - 8;
        doc.text([clubName, t.pdfGenerated(generatedAt)].filter(Boolean).join('  ·  '), 14, footerY);
        doc.text(t.pdfPage(data.pageNumber, totalPagesPlaceholder), pageWidth - 14, footerY, { align: 'right' });
        doc.setTextColor(...PDF_COLORS.text);
      },
      didDrawCell: (data: any) => {
        if (data.section !== 'body' || data.column.index === 0) return;
        // Only draw on student columns (odd indices: 1, 3, 5, ...)
        const isStudentCol = (data.column.index - 1) % 2 === 0;
        if (!isStudentCol) return;
        const key = `${data.row.index}-${data.column.index}`;
        // Draw checkbox
        if (data.cell.raw && String(data.cell.raw).trim()) {
          const x = data.cell.x + boxPad;
          const y = data.cell.y + 3 + (10 * 0.3528 - boxSize) / 2;
          doc.setDrawColor(0);
          doc.setLineWidth(0.3);
          doc.rect(x, y, boxSize, boxSize);
        }
        // Draw membership ID subtitle
        if (subtitles[key]) {
          const nameBaselineY = data.cell.y + 3 + 10 * 0.3528;
          doc.setFontSize(7);
          doc.setFont('helvetica', 'italic');
          doc.setTextColor(120, 120, 120);
          doc.text(subtitles[key], data.cell.x + 8, nameBaselineY + 3);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(...PDF_COLORS.text);
          doc.setFontSize(10);
        }
      },
    });

    doc.putTotalPages(totalPagesPlaceholder);
    doc.save(`schedule-${session.date}.pdf`);
  };

  const isEditableStatus = session.status === 'draft' || session.status === 'scheduled' || session.status === 'invitations_sent';
  const isClosed = session.status === 'completed' || session.status === 'cancelled';
  const showActionsCol = canEdit || session.status === 'invitations_sent';
  const draftReady = session.status === 'draft' && session.instructors.length > 0 && !!session.timetable_id && session.timeslots.length > 0;
  const busy = (key: string) => actionLoading === key;

  const cancelButton = (
    <Button variant="ghost" icon={<Ban />} onClick={cancelSession} disabled={busy('cancelling')}>
      {busy('cancelling') ? t.cancelling : t.cancelSession}
    </Button>
  );
  const headerActions = (() => {
    switch (session.status) {
      case 'draft':
        return draftReady && (
          <>
            {cancelButton}
            <Button variant="primary" icon={<Sparkles />} onClick={generateSchedule} disabled={busy('generating')}>
              {busy('generating') ? t.generating : t.generateSchedule}
            </Button>
          </>
        );
      case 'scheduled':
        return (
          <>
            {cancelButton}
            <Button icon={<RefreshCw />} onClick={generateSchedule} disabled={busy('generating')}>
              {busy('generating') ? t.regenerating : t.regenerateSchedule}
            </Button>
            <Button variant="primary" icon={<Send />} onClick={sendInvitations} disabled={busy('sending')}>
              {busy('sending') ? t.sending : t.sendInvitations}
            </Button>
          </>
        );
      case 'invitations_sent':
        return (
          <>
            {cancelButton}
            <Button variant="primary" icon={<CircleCheck />} onClick={completeSession} disabled={busy('completing')}>
              {busy('completing') ? t.completing : t.markCompleted}
            </Button>
          </>
        );
      case 'cancelled':
        return (
          <Button variant="primary" icon={<RotateCcw />} onClick={reactivateSession} disabled={busy('reactivating')}>
            {busy('reactivating') ? t.reactivating : t.reactivateSession}
          </Button>
        );
      default:
        return null;
    }
  })();

  const studentLabel = (inv: Invitation) => (
    <Row gap={2}>
      <Tooltip content={inv.group_name || t.noData}>
        <span className={styles.groupDot} style={{ background: inv.group_color || undefined }} />
      </Tooltip>
      <span>{inv.student_name}</span>
      {inv.buddy_group_id && buddyColorMap.has(inv.buddy_group_id) && (
        <Tooltip content={inv.buddy_group_name}>
          <span className={buddyStyles.buddyIcon} style={{ '--buddy': buddyColorMap.get(inv.buddy_group_id) } as CSSProperties}>
            <Users />
          </span>
        </Tooltip>
      )}
    </Row>
  );

  return (
    <Page>
      <PageHeader
        back={{ label: t.backToSessions, onClick: () => navigate('/sessions') }}
        title={formatDate(session.date)}
        meta={<SessionStatusBadge status={session.status} />}
        actions={headerActions}
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {draftReady && <Alert tone="info">{t.scheduleHint}</Alert>}

      <div className={styles.setup}>
        <Card title={t.instructorsCount(session.instructors.length)}>
          {session.instructors.length === 0 && !isEditableStatus ? (
            <Text tone="muted">{t.noInstructorsAssigned}</Text>
          ) : (
            <Row gap={2} wrap>
              {session.instructors.map(i => (
                <Popover
                  key={i.id}
                  open={replacingInstructorId === i.id}
                  onOpenChange={open => { if (!open) { setReplacingInstructorId(null); setInstructorQuery(''); } }}
                  align="start"
                  flush
                  className={styles.instructorPanel}
                  anchor={
                    <span className={styles.chipAnchor} data-instructor-id={i.id}>
                      <Chip
                        actions={isClosed ? undefined : [{
                          icon: <ArrowLeftRight />,
                          label: t.replaceInstructor,
                          onClick: () => { setInstructorQuery(''); setReplacingInstructorId(i.id); },
                        }]}
                        onRemove={isClosed ? undefined : () => removeInstructor(i.id)}
                        removeLabel={t.remove}
                      >
                        {i.first_name} {i.last_name}
                      </Chip>
                    </span>
                  }
                >
                  <InstructorPicker
                    title={t.replaceWith(`${i.first_name} ${i.last_name}`)}
                    query={instructorQuery}
                    onQueryChange={setInstructorQuery}
                    emptyText={availableInstructors.length === 0 ? t.allInstructorsAssigned
                      : replacementCandidates.length === 0 ? t.noInstructorsMatch : undefined}
                  >
                    {replacementCandidates.map(inst => (
                      <button
                        key={inst.id}
                        type="button"
                        className={styles.replaceOption}
                        disabled={pendingInstructorId !== null}
                        onClick={() => replaceInstructor(i.id, inst.id)}
                      >
                        {inst.first_name} {inst.last_name}
                      </button>
                    ))}
                  </InstructorPicker>
                </Popover>
              ))}
              {isEditableStatus && (
                <Popover
                  align="start"
                  flush
                  className={styles.instructorPanel}
                  onOpenChange={open => { if (!open) setInstructorQuery(''); }}
                  trigger={<Button size="sm" icon={<Plus />}>{t.addInstructor}</Button>}
                >
                  <InstructorPicker
                    query={instructorQuery}
                    onQueryChange={setInstructorQuery}
                    emptyText={filteredInstructors.length === 0 ? t.noInstructorsMatch : undefined}
                  >
                    {filteredInstructors.map(inst => (
                      <div key={inst.id} className={styles.instructorOption}>
                        <Checkbox
                          checked={assignedIds.has(inst.id)}
                          disabled={pendingInstructorId === inst.id}
                          onCheckedChange={checked => toggleInstructor(inst.id, checked)}
                          label={`${inst.first_name} ${inst.last_name}`}
                        />
                      </div>
                    ))}
                  </InstructorPicker>
                </Popover>
              )}
            </Row>
          )}
        </Card>

        <Card
          title={t.timetableSection}
          actions={session.timeslots.length > 0 && (
            <>
              <Tooltip content={<span className={styles.timeslotList}>{session.timeslots.map(ts => ts.start_time).join(', ')}</span>}>
                <span tabIndex={0}>
                  <Badge mono>{t.timeslotsBadge(session.timeslots.length)}</Badge>
                </span>
              </Tooltip>
              {session.instructors.length > 0 && (
                <Tooltip content={t.slotsInfo}>
                  <span tabIndex={0}>
                    <Badge mono>{t.slotsCount(session.timeslots.length * session.instructors.length)}</Badge>
                  </span>
                </Tooltip>
              )}
            </>
          )}
        >
          <Stack gap={3}>
            {session.status === 'draft' || session.status === 'scheduled' ? (
              <Select aria-label={t.timetableSection} value={session.timetable_id ?? ''} onChange={e => changeTimetable(e.target.value)}>
                <option value="">{t.noTimetable}</option>
                {allTimetables.map(tt => (
                  <option key={tt.id} value={tt.id}>{tt.name}</option>
                ))}
                {session.timetable && !allTimetables.some(tt => tt.id === session.timetable!.id) && (
                  <option value={session.timetable.id}>{session.timetable.name} {t.inactiveSuffix}</option>
                )}
              </Select>
            ) : (
              <Text weight="medium">{session.timetable ? session.timetable.name : t.noTimetableAttached}</Text>
            )}
            <AllocationBar
              legend={false}
              segments={session.timetableGroups.map(g => ({
                name: g.group_name,
                percentage: g.percentage,
                color: g.group_color || 'var(--color-text-subtle)',
              }))}
            />
            {session.timeslots.length === 0 && (
              <Text tone="muted">{session.timetable_id ? t.noTimeslotsInTimetable : t.noTimeslotsAttachFirst}.</Text>
            )}
          </Stack>
        </Card>
      </div>

      {session.invitations.length > 0 && session.instructors.length > 0 && session.timeslots.length > 0 && (
        <Card
          title={t.scheduleOverview}
          actions={<Button size="sm" icon={<FileDown />} onClick={exportPdf}>{t.exportPdf}</Button>}
          flush
        >
          <Table embedded>
            <thead>
              <tr>
                <th>{t.time}</th>
                {session.instructors.map(i => <th key={i.id}>{i.first_name} {i.last_name}</th>)}
              </tr>
            </thead>
            <tbody>
              {session.timeslots.map(ts => (
                <tr key={ts.id}>
                  <td><Text mono weight="medium">{ts.start_time}</Text></td>
                  {session.instructors.map(instr => {
                    const inv = scheduleGrid[ts.id]?.[instr.id];
                    return (
                      <td key={instr.id}>
                        {inv ? (
                          <Stack gap={1}>
                            <Row gap={2} wrap>
                              {studentLabel(inv)}
                              <InvitationStatusBadge status={inv.status} />
                            </Row>
                            {inv.discipline_name && <Text tone="muted" size="xs">{inv.discipline_name}</Text>}
                          </Stack>
                        ) : (
                          <Text tone="subtle">{t.noData}</Text>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {(session.invitations.length > 0 || (canEdit && session.timeslots.length > 0 && session.instructors.length > 0)) && (
        <Card title={t.invitationsCount(session.invitations.length)} flush>
          <div className={styles.summary}>
            <Row gap={2} wrap>
              <Badge tone="success" icon={false}>{t.summaryConfirmed(confirmed)}</Badge>
              <Badge tone="warning" icon={false}>{t.summaryInvited(invited)}</Badge>
              {scheduled > 0 && <Badge icon={false}>{t.summaryScheduled(scheduled)}</Badge>}
              <Badge tone="danger" icon={false}>{t.summaryDeclined(declined)}</Badge>
              {cancelled > 0 && <Badge tone="danger" icon={false}>{t.summaryCancelled(cancelled)}</Badge>}
              {adminCancelled > 0 && <Badge tone="danger" icon={false}>{t.summaryWithdrawn(adminCancelled)}</Badge>}
              {expired > 0 && <Badge tone="danger" icon={false}>{t.summaryExpired(expired)}</Badge>}
              {invalidated > 0 && <Badge tone="danger" icon={false}>{t.summaryInvalidated(invalidated)}</Badge>}
            </Row>
          </div>
          <Table embedded>
            <thead>
              <tr>
                <th>{t.timeslot}</th>
                <th>{t.student}</th>
                <th>{t.discipline}</th>
                <th>{t.status}</th>
                {showActionsCol && <th data-actions />}
              </tr>
            </thead>
            <tbody>
              {slotGroups.map((group, groupIdx) => group.entries.map((slot, idx) => {
                const isFirstInGroup = idx === 0;
                const rowClass = isFirstInGroup && groupIdx > 0 ? styles.slotStart : undefined;
                const timeCell = <td>{isFirstInGroup && <Text mono weight="medium">{slot.startTime}</Text>}</td>;
                const inv = slot.invitation;

                if (inv) {
                  const isActive = !INACTIVE_STATUSES.includes(inv.status);
                  return (
                    <tr key={inv.id} className={rowClass}>
                      {timeCell}
                      <td>
                        <Row gap={2}>
                          {studentLabel(inv)}
                          <DecisionLog decisionLog={inv.decision_log} />
                        </Row>
                      </td>
                      <td>{inv.discipline_name || <Text tone="subtle">{t.noData}</Text>}</td>
                      <td>
                        <Row gap={2} wrap>
                          <InvitationStatusBadge status={inv.status} />
                          {inv.status === 'invited' && inv.expires_at && (
                            <Badge mono icon={<Timer />}><Countdown expiresAt={new Date(inv.expires_at)} /></Badge>
                          )}
                          {inv.status === 'confirmed' && (session.status !== 'completed' ? (
                            <Button
                              size="sm"
                              variant={inv.no_show ? 'danger' : 'secondary'}
                              icon={inv.no_show ? <UserX /> : <UserCheck />}
                              onClick={() => toggleNoShow(inv.id)}
                            >
                              {inv.no_show ? t.noShow : t.show}
                            </Button>
                          ) : (
                            <Badge tone={inv.no_show ? 'danger' : 'neutral'} icon={inv.no_show ? <UserX /> : <UserCheck />}>
                              {inv.no_show ? t.noShow : t.show}
                            </Badge>
                          ))}
                        </Row>
                      </td>
                      {showActionsCol && (
                        <td data-actions>
                          <Row gap={1} justify="end">
                            {!canEdit && (
                              <Tooltip content={t.viewInvitation}>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={<ExternalLink />}
                                  aria-label={t.viewInvitation}
                                  onClick={() => window.open(`/invitation/${inv.token}`, '_blank', 'noopener')}
                                />
                              </Tooltip>
                            )}
                            {isActive && (canEdit ? (
                              <Tooltip content={t.remove}>
                                <Button variant="ghost" size="sm" icon={<X />} aria-label={t.remove} onClick={() => removeInvitation(inv.id)} />
                              </Tooltip>
                            ) : (
                              <Tooltip content={t.adminCancelInvitation}>
                                <Button variant="ghost" size="sm" icon={<Ban />} aria-label={t.adminCancelInvitation} onClick={() => adminCancelInvitation(inv.id)} />
                              </Tooltip>
                            ))}
                          </Row>
                        </td>
                      )}
                    </tr>
                  );
                }

                if (!slot.empty || !showActionsCol) return null;
                const isAdding = addSlot?.timeslotId === slot.timeslotId && addSlot?.instructorId === slot.instructorId;
                return (
                  <tr key={`empty-${slot.timeslotId}-${slot.instructorId}-${idx}`} className={`${styles.emptySlot} ${rowClass ?? ''}`}>
                    {timeCell}
                    <td colSpan={2}>
                      {isAdding ? (
                        <div ref={dropdownRef} className={styles.slotSearch}>
                          <Input
                            type="search"
                            autoComplete="off"
                            autoFocus
                            aria-label={t.searchStudent}
                            placeholder={t.searchStudent}
                            value={studentSearch}
                            onChange={e => searchStudents(e.target.value)}
                          />
                          {showStudentDropdown && (
                            <StudentSearchResults results={studentResults} onSelect={s => addStudentToSlot(s.id)} up={dropdownUp} />
                          )}
                        </div>
                      ) : (
                        <Row gap={2}>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<UserPlus />}
                            onClick={() => { setAddSlot({ timeslotId: slot.timeslotId, instructorId: slot.instructorId }); setStudentSearch(''); setStudentResults([]); }}
                          >
                            {t.addStudentToSlot}
                          </Button>
                          {session.status === 'invitations_sent' && (
                            <Tooltip content={t.autoScheduleStudent}>
                              <Button size="sm" variant="ghost" icon={<Wand2 />} onClick={() => autoScheduleSlot(slot.timeslotId, slot.instructorId)}>
                                {t.autoScheduleLabel}
                              </Button>
                            </Tooltip>
                          )}
                        </Row>
                      )}
                    </td>
                    <td />
                    {showActionsCol && <td />}
                  </tr>
                );
              }))}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}

