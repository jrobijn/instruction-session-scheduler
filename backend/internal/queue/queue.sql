-- The invite queue: one row per non-deleted student in a group, with the columns of
-- queue.Member (loaded by queue.LoadMembers). It takes no parameters, so it can be run as is:
--
--   sqlite3 data.db < internal/queue/queue.sql
--
-- Standing columns:
--
--   last_turn_at               The latest session date with a counted invitation (scheduled,
--                              invited or confirmed); NULL if the student never had a turn.
--   queue_at                   When the student was last sent to the back of the queue: the
--                              latest of their last turn and each event whose group policy is
--                              'back' (joining, reactivation, end of cooldown). Policies apply
--                              at query time. Empty if none of these happened: the front of
--                              the queue.
--   queue_reason               'joined', 'reactivated' or 'cooldown' when that event, not the
--                              last turn, determines queue_at; otherwise NULL.
--   invite_next_pending_since  When an "invite next" override was set, while it is pending (no
--                              counted invitation since); otherwise NULL, also once the
--                              override is used up.
--   queue_position             The queue order, 1 first. Pending "invite next" overrides come
--                              first (oldest first), then everyone by queue_at (empty first).
--                              Students with the same position are tied; queue.Sort breaks
--                              those ties. Positions span all groups, so within one group they
--                              are ordered but not consecutive.
--
-- All standing timestamps are normalized with datetime(), so comparing them as text is
-- chronological.

WITH queue_turns AS (
  SELECT i.student_id,
    MAX(datetime(ts.date)) AS last_turn_at,
    MAX(datetime(i.invited_at)) AS last_invited_at
  FROM invitations i
  JOIN training_sessions ts ON ts.id = i.session_id
  WHERE i.status IN ('scheduled', 'invited', 'confirmed')
  GROUP BY i.student_id
),
queue_events AS (
  -- The *_back_at columns are when that event sent the student to the back of the queue:
  -- NULL unless the group's policy for it is 'back'.
  SELECT s.id, s.first_name, s.last_name, s.email, s.active, s.preferred_days,
    s.cooldown_until, sg.group_id, t.last_turn_at,
    CASE WHEN g.new_member_priority = 'back' THEN datetime(sg.joined_at) END AS joined_back_at,
    CASE WHEN g.reactivated_member_priority = 'back' THEN datetime(sg.reactivated_at) END AS reactivated_back_at,
    CASE WHEN g.cooldown_member_priority = 'back' THEN datetime(s.cooldown_until) END AS cooldown_back_at,
    CASE WHEN sg.invite_next_at IS NOT NULL
      AND (t.last_invited_at IS NULL OR t.last_invited_at < datetime(sg.invite_next_at))
      THEN datetime(sg.invite_next_at) END AS invite_next_pending_since
  FROM student_groups sg
  JOIN students s ON s.id = sg.student_id AND s.deleted_at IS NULL
  LEFT JOIN groups g ON g.id = sg.group_id
  LEFT JOIN queue_turns t ON t.student_id = sg.student_id
),
queue_times AS (
  SELECT *,
    MAX(
      COALESCE(last_turn_at, ''),
      COALESCE(joined_back_at, ''),
      COALESCE(reactivated_back_at, ''),
      COALESCE(cooldown_back_at, '')
    ) AS queue_at
  FROM queue_events
)
SELECT id, first_name, last_name, email, active, preferred_days,
  cooldown_until, group_id,
  last_turn_at, queue_at, invite_next_pending_since,
  DENSE_RANK() OVER (
    ORDER BY invite_next_pending_since IS NULL, invite_next_pending_since, queue_at
  ) AS queue_position,
  CASE
    WHEN queue_at <= COALESCE(last_turn_at, '') THEN NULL
    WHEN queue_at = joined_back_at THEN 'joined'
    WHEN queue_at = reactivated_back_at THEN 'reactivated'
    WHEN queue_at = cooldown_back_at THEN 'cooldown'
  END AS queue_reason
FROM queue_times;
