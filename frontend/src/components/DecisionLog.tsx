import { Check, Info, NotebookPen, Shuffle, Users } from 'lucide-react';
import { useT, getLocale } from '../i18n';
import { Badge, Popover } from '../ui';
import { GroupLabel } from './StatusBadges';
import styles from './DecisionLog.module.css';

interface DecisionLogData {
  trigger: 'batch_schedule' | 'replacement';
  student_priority?: number;
  last_turn_at?: string | null;
  invite_next?: boolean;
  candidate_rank: number;
  candidates_considered: number;
  group_name: string | null;
  group_color: string | null;
  group_quota: string | null;
  preferred_timeslots: string[] | null;
  preferred_days: number[] | null;
  buddy_placed_near: string | null;
  overflow: boolean;
  replaced_student: string | null;
  replacement_reason: string | null;
  same_group_match: boolean;
}

export default function DecisionLog({ decisionLog }: { decisionLog: string | null }) {
  const t = useT();

  if (!decisionLog) return null;

  let data: DecisionLogData;
  try {
    data = JSON.parse(decisionLog);
  } catch {
    return null;
  }

  const isReplacement = data.trigger === 'replacement';
  // Logs written before the queue model have no last_turn_at (and may carry student_priority).
  const isLegacy = data.last_turn_at === undefined;
  const queueReason = isLegacy
    ? (data.student_priority !== undefined ? `${t.decisionPriority} ${data.student_priority}` : null)
    : data.invite_next
      ? t.decisionInviteNext
      : data.last_turn_at
        ? t.decisionLastInvited(new Date(data.last_turn_at.slice(0, 10) + 'T00:00:00').toLocaleDateString(getLocale() === 'nl' ? 'nl-NL' : 'en-GB'))
        : t.decisionNeverInvited;

  const showDays = !!data.preferred_days && data.preferred_days.length > 0 && data.preferred_days.length < 7;
  const showTimeslots = !!data.preferred_timeslots && data.preferred_timeslots.length > 0;

  return (
    <Popover
      className={styles.panel}
      trigger={
        <button type="button" className={styles.trigger} aria-label={t.decisionLogTitle} title={t.decisionLogTitle}>
          <Info />
        </button>
      }
    >
      <div className={styles.header}>
        <NotebookPen />
        <span className={styles.title}>{t.decisionLogTitle}</span>
        <Badge tone={isReplacement ? 'warning' : 'info'} icon={false}>
          {isReplacement ? t.decisionTriggerReplacement : t.decisionTriggerBatch}
        </Badge>
      </div>

      {isReplacement && data.replaced_student && (
        <p className={styles.note}>{t.decisionReplacedStudent(data.replaced_student)}</p>
      )}

      <div className={styles.rank}>
        <span className={styles.rankNumber}>
          {isLegacy && data.student_priority !== undefined ? data.student_priority : data.candidate_rank}
        </span>
        <span className={styles.rankText}>
          {queueReason && <span className={styles.reason}>{queueReason}</span>}
          <span className={styles.muted}>{t.decisionCandidateRank(data.candidate_rank, data.candidates_considered)}</span>
        </span>
      </div>

      {data.group_name && (
        <div className={styles.group}>
          <GroupLabel name={data.group_name} color={data.group_color} />
          {data.group_quota && <span className={styles.mono}>{data.group_quota}</span>}
        </div>
      )}

      {(showDays || showTimeslots) && (
        <div className={styles.section}>
          {showDays && (
            <div className={styles.prefs}>
              <span className={styles.label}>{t.decisionPreferredDays}</span>
              <div className={styles.tags}>
                {data.preferred_days!.map(day => <span key={day} className={styles.tag}>{t.days[day]}</span>)}
              </div>
            </div>
          )}
          {showTimeslots && (
            <div className={styles.prefs}>
              <span className={styles.label}>{t.decisionPreferredTimeslots}</span>
              <div className={styles.tags}>
                {data.preferred_timeslots!.map(ts => <span key={ts} className={`${styles.tag} ${styles.mono}`}>{ts}</span>)}
              </div>
            </div>
          )}
        </div>
      )}

      {(data.buddy_placed_near || data.overflow || isReplacement) && (
        <div className={styles.section}>
          {data.buddy_placed_near && (
            <p className={styles.message}><Users />{t.decisionBuddyPlacedNear(data.buddy_placed_near)}</p>
          )}
          {data.overflow && <p className={styles.note}>{t.decisionOverflow}</p>}
          {isReplacement && (
            <p className={styles.message} data-match={data.same_group_match || undefined}>
              {data.same_group_match ? <Check /> : <Shuffle />}
              {data.same_group_match ? t.decisionSameGroupMatch : t.decisionCrossGroupMatch}
            </p>
          )}
        </div>
      )}
    </Popover>
  );
}
