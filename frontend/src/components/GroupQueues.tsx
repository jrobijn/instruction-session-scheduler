import { useState, type ReactNode } from 'react';
import { Users } from 'lucide-react';
import { useT, getLocale } from '../i18n';
import { Badge, EmptyState, Row, Stack, Tab, TabList, TabPanel, Tabs, Text, type ActionMenuItem } from '../ui';
import { QueueTable, type QueueEntry } from './QueueTable';
import { GroupDot } from './StatusBadges';
import styles from './GroupQueues.module.css';

export type Unavailable = 'inactive' | 'group' | 'invited' | 'otherDay' | 'cooldown';

/** A student in a group's queue for a date, as the server lists them. */
export interface GroupQueueEntry extends QueueEntry {
  /** Start times of the timeslots they prefer; null if they have no preference. */
  preferred_timeslots: string[] | null;
  cooldown_until: string | null;
  /** Why the student can't be invited on the date; '' for students in the queue. */
  unavailable: Unavailable | '';
  /** What generating a session's schedule would do with them; only in a schedule preview. */
  schedule: {
    invited: boolean;
    /** The start time they would get, if invited. */
    start_time: string | null;
    overflow: boolean;
    /** Up for a spot, but none of the timeslots they allow had room. */
    skipped: boolean;
  } | null;
}

export interface GroupQueue {
  group_id: number;
  group_name: string;
  group_color: string;
  percentage: number;
  /** The group's quota of a session's spots; only in a schedule preview. */
  slots: number | null;
  queue: GroupQueueEntry[];
  /** Members who can't be invited on the date, in the order the queue would have had them. */
  unavailable: GroupQueueEntry[];
}

export interface QueueTimeslot {
  id: number;
  start_time: string;
}

interface GroupQueuesProps {
  groups: GroupQueue[];
  /** The timetable's timeslots, earliest first. */
  timeslots: QueueTimeslot[];
  /** The weekday the queues are for, as a word, for students who can't come that day. */
  dayName: string;
  /** Shown above a group's table: emptyHint when nobody can be invited, groupHint otherwise. */
  groupHint: (group: GroupQueue) => ReactNode;
  emptyHint: string;
  /** Shown after the group's name in its tab. */
  tabCount: (group: GroupQueue) => ReactNode;
  /** The last column: the reason for unavailable students, statusCell for the others. */
  statusLabel: string;
  statusCell?: (entry: GroupQueueEntry) => ReactNode;
  actions?: (group: GroupQueue, entry: GroupQueueEntry) => ActionMenuItem[];
}

/** Each group's queue in a tab, with the students who can't come greyed out below it. */
export function GroupQueues({ groups, timeslots, dayName, groupHint, emptyHint, tabCount, statusLabel, statusCell, actions }: GroupQueuesProps) {
  const t = useT();
  const [tabPref, setTab] = useState('');
  const tab = groups.some(g => String(g.group_id) === tabPref) ? tabPref : String(groups[0]?.group_id ?? '');
  const dateLocale = getLocale() === 'nl' ? 'nl-NL' : 'en-GB';

  // Every timeslot of the timetable, so rows line up: the assigned one green, the ones the
  // student doesn't prefer faded. Without preferences, every timeslot is allowed.
  const timeslotsCell = (e: GroupQueueEntry) => (
    <div className={styles.timeslots}>
      {timeslots.map(ts => ts.start_time === e.schedule?.start_time ? (
        <Badge key={ts.id} tone="success" mono>{ts.start_time.slice(0, 5)}</Badge>
      ) : (
        <Badge key={ts.id} mono icon={false} faded={!!e.preferred_timeslots && !e.preferred_timeslots.includes(ts.start_time)}>
          {ts.start_time.slice(0, 5)}
        </Badge>
      ))}
    </div>
  );

  const lastCell = (e: GroupQueueEntry) => e.unavailable ? (
    <Text tone="subtle" size="sm">
      {t.previewUnavailable(
        e.unavailable,
        dayName,
        e.cooldown_until ? new Date(e.cooldown_until.replace(' ', 'T') + 'Z').toLocaleDateString(dateLocale) : '',
      )}
    </Text>
  ) : statusCell?.(e);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabList>
        {groups.map(g => (
          <Tab key={g.group_id} value={String(g.group_id)}>
            <Row gap={2}>
              <GroupDot name={g.group_name} color={g.group_color} />
              {g.group_name}
              <Text mono tone="muted">{tabCount(g)}</Text>
            </Row>
          </Tab>
        ))}
      </TabList>
      {groups.map(g => (
        <TabPanel key={g.group_id} value={String(g.group_id)}>
          {g.queue.length === 0 && g.unavailable.length === 0 ? (
            <EmptyState icon={<Users />} title={t.noMembers} />
          ) : (
            <Stack gap={3}>
              <Text as="p" tone="muted" size="sm">
                {g.queue.length === 0 ? emptyHint : groupHint(g)}
              </Text>
              <QueueTable
                entries={[...g.queue, ...g.unavailable]}
                dayName={dayName}
                muted={e => e.unavailable !== ''}
                columns={[
                  { label: t.timeslots, cell: timeslotsCell },
                  { label: statusLabel, cell: lastCell },
                ]}
                actions={actions && (e => actions(g, e))}
              />
            </Stack>
          )}
        </TabPanel>
      ))}
    </Tabs>
  );
}
