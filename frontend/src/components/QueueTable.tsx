import type { CSSProperties, ReactNode } from 'react';
import { ChevronsDown, ChevronsUp, Link2, Users } from 'lucide-react';
import { useT, getLocale } from '../i18n';
import { ActionMenu, Row, Stack, Table, Text, Tooltip, type ActionMenuItem } from '../ui';
import { cx } from '../ui/cx';
import buddyStyles from './BuddyRows.module.css';
import styles from './QueueTable.module.css';

export type ApartReason = 'otherGroup' | 'noGroup' | 'inactive' | 'cooldown' | 'otherDay' | 'invited';

/** A student in a queue, in queue order. */
export interface QueueEntry {
  id: number;
  first_name: string;
  last_name: string;
  /** Null for students listed apart, who are not in the queue. */
  queue_position: number | null;
  last_turn_at: string | null;
  invite_next: boolean;
  queue_override: { reason: 'joined' | 'reactivated' | 'cooldown'; at: string } | null;
  buddy_group_id: number | null;
  /** The other members of their buddy group; apart says why one can't come along ('' if they can). */
  buddies: Array<{ id: number; first_name: string; last_name: string; group_name: string | null; apart: ApartReason | '' }> | null;
}

interface QueueTableProps<E extends QueueEntry> {
  entries: E[];
  /** The weekday the queue is for, as a word, for buddies who can't come that day. */
  dayName: string;
  /** Extra columns after the standard ones. */
  columns?: Array<{ label: string; cell: (entry: E) => ReactNode }>;
  /** Greys out students who are listed but out of the queue. */
  muted?: (entry: E) => boolean;
  /** A row menu per student; rows without actions get an empty cell. */
  actions?: (entry: E) => ActionMenuItem[];
}

// Distinct data colours per buddy group
const BUDDY_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#c026d3', '#ea580c', '#4f46e5', '#059669'];

/** A queue in the order students are invited, with buddies who come along kept together. */
export function QueueTable<E extends QueueEntry>({ entries, dayName, columns = [], muted, actions }: QueueTableProps<E>) {
  const t = useT();
  const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';

  const byId = new Map(entries.map(e => [e.id, e]));
  const together = (e: E) => (e.buddies ?? []).filter(b => b.apart === '' && byId.has(b.id)).map(b => byId.get(b.id)!);
  const linkedBuddyId = (e: E) => together(e).length > 0 ? e.buddy_group_id! : undefined;

  // Buddies who come along follow the first of them in the queue
  const placed = new Set<number>();
  const rows: E[] = [];
  for (const e of entries) {
    if (placed.has(e.id)) continue;
    rows.push(e);
    placed.add(e.id);
    const linkedId = linkedBuddyId(e);
    if (!linkedId) continue;
    for (const b of entries) {
      if (!placed.has(b.id) && linkedBuddyId(b) === linkedId) {
        rows.push(b);
        placed.add(b.id);
      }
    }
  }

  const buddyColor = new Map<number, string>();
  [...new Set(rows.map(linkedBuddyId).filter(Boolean))].forEach((id, i) => buddyColor.set(id!, BUDDY_COLORS[i % BUDDY_COLORS.length]));

  const apartDetail = (reason: ApartReason, buddy: { first_name: string; group_name: string | null }) =>
    reason === 'otherGroup' ? buddy.group_name ?? '' : reason === 'otherDay' ? dayName : buddy.first_name;

  return (
    <Table>
      <thead>
        <tr>
          <th data-numeric data-shrink>{t.queuePosition}</th>
          <th>{t.name}</th>
          <th>{t.lastInvited}</th>
          {columns.map(c => <th key={c.label}>{c.label}</th>)}
          {actions && <th data-actions>{t.actions}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((e, idx) => {
          const buddyId = linkedBuddyId(e);
          const isFirstInBuddy = !!buddyId && (idx === 0 || linkedBuddyId(rows[idx - 1]) !== buddyId);
          const isLastInBuddy = !!buddyId && (idx === rows.length - 1 || linkedBuddyId(rows[idx + 1]) !== buddyId);
          const along = together(e);
          const apart = (e.buddies ?? []).filter(b => b.apart !== '');
          // The buddy first in the queue takes the others along
          const leader = along.reduce<E | null>((best, b) => b.queue_position! < (best ?? e).queue_position! ? b : best, null);
          const isMuted = muted?.(e) ?? false;
          const overrideAt = e.queue_override && new Date(e.queue_override.at.replace(' ', 'T') + 'Z');
          return (
            <tr
              key={e.id}
              style={buddyId ? { '--buddy': buddyColor.get(buddyId) } as CSSProperties : undefined}
              data-first={isFirstInBuddy || undefined}
              data-last={isLastInBuddy || undefined}
              className={cx(!!buddyId && buddyStyles.buddyRow, isMuted && styles.muted)}
            >
              <td data-numeric data-shrink>
                <Row gap={1} justify="end">
                  {e.queue_override && overrideAt && !e.invite_next && (
                    <Tooltip content={t.queueOverrideTooltip(e.queue_override.reason, overrideAt.toLocaleDateString(dateLocale), overrideAt > new Date())}>
                      <span className={cx(styles.flag, styles.warning)}><ChevronsDown /></span>
                    </Tooltip>
                  )}
                  {e.invite_next && (
                    <Tooltip content={t.inviteNextTooltip}>
                      <span className={cx(styles.flag, styles.success)}><ChevronsUp /></span>
                    </Tooltip>
                  )}
                  {leader && (
                    <Tooltip content={t.buddyFollowerTooltip(`${leader.first_name} ${leader.last_name}`, leader.queue_position!)}>
                      <span className={cx(styles.flag, buddyStyles.buddyIcon)}><Link2 /></span>
                    </Tooltip>
                  )}
                  <span>{e.queue_position ?? t.noData}</span>
                </Row>
              </td>
              <td>
                <Row gap={2}>
                  <Text weight="medium" tone={isMuted ? 'subtle' : undefined}>{e.first_name} {e.last_name}</Text>
                  {e.buddies && e.buddies.length > 0 && (
                    <Tooltip content={
                      <Stack gap={1}>
                        {along.length > 0 && (
                          <span>{t.buddyInvitedTogether(along.map(b => `${b.first_name} ${b.last_name}`).join(' & '))}</span>
                        )}
                        {apart.map(b => (
                          <span key={b.id}>
                            {t.buddyNotTogether(`${b.first_name} ${b.last_name}`, b.apart as ApartReason, apartDetail(b.apart as ApartReason, b))}
                          </span>
                        ))}
                      </Stack>
                    }>
                      <span className={cx(styles.flag, buddyStyles.buddyIcon)} data-muted={along.length === 0 || undefined}>
                        <Users />
                      </span>
                    </Tooltip>
                  )}
                </Row>
              </td>
              <td>
                {e.last_turn_at
                  ? <Text mono tone={isMuted ? 'subtle' : undefined}>{new Date(e.last_turn_at.slice(0, 10) + 'T00:00:00').toLocaleDateString(dateLocale)}</Text>
                  : <Text tone="subtle">{t.neverInvited}</Text>}
              </td>
              {columns.map(c => <td key={c.label}>{c.cell(e)}</td>)}
              {actions && (
                <td data-actions>
                  {actions(e).length > 0 && <ActionMenu actions={actions(e)} />}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
