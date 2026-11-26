import { useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';
import { Alert, Badge, Button, Dialog, Row, Stack, Text, Tooltip } from '../ui';
import { GroupQueues, type GroupQueue, type GroupQueueEntry, type QueueTimeslot } from './GroupQueues';

interface SchedulePreview {
  total_slots: number;
  students_invited: number;
  timeslots: QueueTimeslot[];
  groups: GroupQueue[];
}

interface SchedulePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number;
  /** YYYY-MM-DD */
  sessionDate: string;
  /** The session already has a schedule, which generating would replace. */
  regenerate: boolean;
  generating: boolean;
  onGenerate: () => void;
}

/**
 * Each of the session's groups' queue for this session, and who generating the schedule would
 * invite from it. Computed by the server with the scheduler itself.
 */
export function SchedulePreviewDialog({ open, onOpenChange, sessionId, sessionDate, regenerate, generating, onGenerate }: SchedulePreviewDialogProps) {
  const t = useT();
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [error, setError] = useState('');

  // Fetched on every open: the preview is only valid for the state it was computed from.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setError('');
    api.getSchedulePreview(sessionId)
      .then((p: SchedulePreview) => { if (!cancelled) setPreview(p); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [open, sessionId]);

  const dayName = t.daysFull[new Date(sessionDate + 'T00:00:00').getDay()];

  const sessionCell = (e: GroupQueueEntry) => {
    if (e.schedule?.skipped) {
      return (
        <Tooltip content={t.previewSkippedTooltip(e.preferred_timeslots?.join(', ') ?? '')}>
          <span><Badge tone="warning">{t.previewSkipped}</Badge></span>
        </Tooltip>
      );
    }

    if (!e.schedule?.invited) return null;

    const badge = <Badge tone="success">{t.previewInvited}</Badge>;
    return e.schedule.overflow ? <Tooltip content={t.previewOverflowTooltip}><span>{badge}</span></Tooltip> : badge;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={t.schedulePreviewTitle}
      description={t.schedulePreviewHint(dayName)}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t.close}</Button>
          <Button
            variant="primary"
            icon={regenerate ? <RefreshCw /> : <Sparkles />}
            onClick={onGenerate}
            disabled={generating || !preview}
          >
            {regenerate
              ? (generating ? t.regenerating : t.regenerateSchedule)
              : (generating ? t.generating : t.generateSchedule)}
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger">{error}</Alert>
      ) : !preview ? (
        <Text tone="muted">{t.loading}</Text>
      ) : (
        <Stack gap={4}>
          {regenerate && <Alert tone="info">{t.regeneratePreviewHint}</Alert>}
          <Row gap={2}>
            <Badge mono icon={false}>{t.slotsCount(preview.total_slots)}</Badge>
            <Badge mono icon={false}>{t.previewInvitedCount(preview.students_invited)}</Badge>
          </Row>
          <GroupQueues
            groups={preview.groups}
            timeslots={preview.timeslots}
            dayName={dayName}
            groupHint={g => t.previewGroupHint(g.slots ?? 0)}
            emptyHint={t.previewNoOneInGroup(dayName)}
            tabCount={g => `${g.queue.filter(e => e.schedule?.invited).length}/${g.queue.length}`}
            statusLabel={t.previewThisSession}
            statusCell={sessionCell}
          />
        </Stack>
      )}
    </Dialog>
  );
}
