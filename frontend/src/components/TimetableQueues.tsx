import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { Alert, Card, SegmentedControl, Stack, Text, useToast } from '../ui';
import { GroupQueues, type GroupQueue, type GroupQueueEntry, type QueueTimeslot } from './GroupQueues';

interface TimetableQueuesData {
  timeslots: QueueTimeslot[];
  groups: GroupQueue[];
}

interface TimetableQueuesProps {
  timetableId: number;
  /** Changes when the timetable's groups change, so the queues are fetched again. */
  groupsKey: string;
}

/**
 * The queue of each of the timetable's groups as it stands today, for one weekday or any.
 * Without a session it can't say who gets a spot: that depends on the session's instructors.
 */
export function TimetableQueues({ timetableId, groupsKey }: TimetableQueuesProps) {
  const t = useT();
  const toast = useToast();
  const [clubDays, setClubDays] = useState<number[]>([]);
  const [dayPref, setDayPref] = useState<number | null>(() => {
    const stored = localStorage.getItem('timetableQueueDay');
    return stored ? Number(stored) : null;
  });
  const day = dayPref != null && clubDays.includes(dayPref) ? dayPref : null;
  const [data, setData] = useState<TimetableQueuesData | null>(null);
  const [error, setError] = useState('');

  const changeDay = (value: string) => {
    const d = value === 'all' ? null : Number(value);
    setDayPref(d);
    if (d == null) localStorage.removeItem('timetableQueueDay');
    else localStorage.setItem('timetableQueueDay', String(d));
  };

  useEffect(() => {
    api.getSettings()
      .then((settings: { club_days?: string }) => setClubDays((settings.club_days || '0|1|2|3|4|5|6').split('|').map(Number).sort()))
      .catch((err: Error) => setError(err.message));
  }, []);

  const load = async () => {
    try {
      setData(await api.getTimetableQueues(timetableId, day));
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => { load(); }, [timetableId, day, groupsKey]);

  const toggleInviteNext = async (e: GroupQueueEntry) => {
    try {
      await api.setStudentInviteNext(e.id, !e.invite_next);
      load();
    } catch (err: any) {
      toast(err.message);
    }
  };

  const dayName = day == null ? '' : t.daysFull[day];

  return (
    <Card
      title={t.queuesTitle}
      actions={clubDays.length > 1 && (
        <SegmentedControl
          aria-label={t.queueDay}
          value={day == null ? 'all' : String(day)}
          onValueChange={changeDay}
          options={[
            { value: 'all', label: t.allDaysOption },
            ...clubDays.map(d => ({ value: String(d), label: t.days[d] })),
          ]}
        />
      )}
    >
      {error ? (
        <Alert tone="danger">{error}</Alert>
      ) : !data ? (
        <Text tone="muted">{t.loading}</Text>
      ) : (
        <Stack gap={4}>
          <Text as="p" tone="muted" size="sm">
            {t.timetableQueuesHint(day == null ? null : dayName)}
          </Text>
          <GroupQueues
            groups={data.groups}
            timeslots={data.timeslots}
            dayName={dayName}
            groupHint={g => t.timetableQueueGroupHint(g.percentage)}
            emptyHint={day == null ? t.timetableQueueEmpty : t.previewNoOneInGroup(dayName)}
            tabCount={g => g.queue.length}
            statusLabel={t.queueAvailability}
            actions={(_, e) => [{ label: e.invite_next ? t.cancelInviteNext : t.inviteNext, onClick: () => toggleInviteNext(e) }]}
          />
        </Stack>
      )}
    </Card>
  );
}
