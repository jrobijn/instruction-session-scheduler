import db from './database.js';

const timers = new Map<number, ReturnType<typeof setTimeout>>();
let onExpire: ((invitationId: number) => Promise<void>) | null = null;

export function initExpiryTimers(handler: (invitationId: number) => Promise<void>) {
  onExpire = handler;
}

export function getExpiryMinutes(): number {
  return Number(
    (db.prepare("SELECT value FROM settings WHERE key = 'invitation_expiry_minutes'").get() as any)?.value || '120'
  );
}

export function computeExpiresAt(invitedAt: string, expiryMinutes: number): Date {
  const d = new Date(invitedAt + 'Z');
  d.setMinutes(d.getMinutes() + expiryMinutes);
  return d;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function getClubTimeZone(): string {
  const tz = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as any)?.value;
  return tz && isValidTimeZone(tz) ? tz : 'Europe/Amsterdam';
}

// Difference between wall-clock time in timeZone and UTC at the given instant.
function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

// Session date + start time are wall-clock times in the club's time zone setting.
export function getSlotStart(sessionDate: string, startTime: string): Date {
  const timeZone = getClubTimeZone();
  const [y, m, d] = sessionDate.split('-').map(Number);
  const [hh, mm] = startTime.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  const offset = getTimeZoneOffsetMs(wallClockAsUtc, timeZone);
  // Re-check the offset at the resulting instant in case a DST switch lies in between.
  const correctedOffset = getTimeZoneOffsetMs(wallClockAsUtc - offset, timeZone);
  return new Date(wallClockAsUtc - correctedOffset);
}

export function getInvitationDeadline(invitedAt: string, sessionDate: string, startTime: string, expiryMinutes: number): Date {
  const slotStart = getSlotStart(sessionDate, startTime);
  if (expiryMinutes <= 0) return slotStart;
  const byMinutes = computeExpiresAt(invitedAt, expiryMinutes);
  return byMinutes < slotStart ? byMinutes : slotStart;
}

export type InvitationTiming = { status: string; invited_at: string | null; session_date: string; timeslot_start_time: string };

// Status as it should be shown, even if the expiry timer has not fired yet.
export function getEffectiveStatus(inv: InvitationTiming, expiryMinutes: number): string {
  if (inv.status !== 'invited') return inv.status;
  if (Date.now() >= getSlotStart(inv.session_date, inv.timeslot_start_time).getTime()) return 'invalidated';
  if (expiryMinutes > 0 && inv.invited_at && Date.now() > computeExpiresAt(inv.invited_at, expiryMinutes).getTime()) return 'expired';
  return 'invited';
}

export function getExpiresAtIso(inv: InvitationTiming, expiryMinutes: number): string | null {
  if (inv.status !== 'invited' || !inv.invited_at) return null;
  return getInvitationDeadline(inv.invited_at, inv.session_date, inv.timeslot_start_time, expiryMinutes).toISOString();
}

// setTimeout fires immediately for delays above 2^31-1 ms (~24.8 days).
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function scheduleInvitationExpiry(invitationId: number, expiresAtMs: number) {
  cancelInvitationExpiry(invitationId);
  const delay = Math.max(0, expiresAtMs - Date.now());
  if (delay > MAX_TIMEOUT_MS) {
    timers.set(invitationId, setTimeout(() => scheduleInvitationExpiry(invitationId, expiresAtMs), MAX_TIMEOUT_MS));
    return;
  }
  const timer = setTimeout(async () => {
    timers.delete(invitationId);
    try {
      if (onExpire) await onExpire(invitationId);
    } catch (err) {
      console.error(`Error processing expiry for invitation ${invitationId}:`, err);
    }
  }, delay);
  timers.set(invitationId, timer);
}

export function scheduleExpiryForInvitation(invitationId: number) {
  const inv = db.prepare(`
    SELECT inv.invited_at, ts.date AS session_date, tslot.start_time AS timeslot_start_time
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    JOIN timeslots tslot ON tslot.id = inv.timeslot_id
    WHERE inv.id = ? AND inv.status = 'invited'
  `).get(invitationId) as { invited_at: string; session_date: string; timeslot_start_time: string } | undefined;
  if (!inv) return;
  const deadline = getInvitationDeadline(inv.invited_at, inv.session_date, inv.timeslot_start_time, getExpiryMinutes());
  scheduleInvitationExpiry(invitationId, deadline.getTime());
}

export function cancelInvitationExpiry(invitationId: number) {
  const timer = timers.get(invitationId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(invitationId);
  }
}

export function cancelAllSessionTimers(sessionId: number) {
  const invitations = db.prepare(
    "SELECT id FROM invitations WHERE session_id = ? AND status = 'invited'"
  ).all(sessionId) as Array<{ id: number }>;
  for (const inv of invitations) {
    cancelInvitationExpiry(inv.id);
  }
}

export function clearAllTimers() {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

export function rehydrateTimers() {
  clearAllTimers();
  const expiryMinutes = getExpiryMinutes();

  const pending = db.prepare(`
    SELECT inv.id, inv.invited_at, ts.date AS session_date, tslot.start_time AS timeslot_start_time
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    JOIN timeslots tslot ON tslot.id = inv.timeslot_id
    WHERE inv.status = 'invited'
      AND ts.status NOT IN ('completed', 'cancelled')
  `).all() as Array<{ id: number; invited_at: string; session_date: string; timeslot_start_time: string }>;

  for (const inv of pending) {
    const deadline = getInvitationDeadline(inv.invited_at, inv.session_date, inv.timeslot_start_time, expiryMinutes);
    scheduleInvitationExpiry(inv.id, deadline.getTime());
  }

  console.log(`Rehydrated ${pending.length} invitation expiry timer(s)`);
}
