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

export function isInvitationLogicallyExpired(invitedAt: string, expiryMinutes: number): boolean {
  if (expiryMinutes <= 0) return false;
  return Date.now() > computeExpiresAt(invitedAt, expiryMinutes).getTime();
}

export function scheduleInvitationExpiry(invitationId: number, expiresAtMs: number) {
  cancelInvitationExpiry(invitationId);
  const delay = Math.max(0, expiresAtMs - Date.now());
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
  if (expiryMinutes <= 0) return;

  const pending = db.prepare(`
    SELECT inv.id, inv.invited_at
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    WHERE inv.status = 'invited'
      AND ts.status NOT IN ('completed', 'cancelled')
  `).all() as Array<{ id: number; invited_at: string }>;

  for (const inv of pending) {
    const expiresAt = computeExpiresAt(inv.invited_at, expiryMinutes);
    scheduleInvitationExpiry(inv.id, expiresAt.getTime());
  }

  console.log(`Rehydrated ${pending.length} invitation expiry timer(s)`);
}
