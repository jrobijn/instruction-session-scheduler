package queue

import (
	"context"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"testing"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
)

// --- LoadMembers: these tests run the CTE against a migrated database --------------------

// queueDB is a migrated database with two sessions that invitations can point at.
type queueDB struct {
	t        *testing.T
	db       *db.DB
	sessions map[string]int64 // session date -> id
	timeslot int64
	slots    map[string]int64 // session date -> session slot id
	tokens   int
}

func newQueueDB(t *testing.T) *queueDB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := d.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	q := &queueDB{t: t, db: d, sessions: map[string]int64{}, slots: map[string]int64{}}
	timetable := q.insert("INSERT INTO timetables (name) VALUES ('T')")
	q.timeslot = q.insert("INSERT INTO timeslots (timetable_id, start_time) VALUES (?, '18:00')", timetable)
	instructor := q.insert("INSERT INTO instructors (first_name, last_name, email) VALUES ('I', 'I', 'i@test')")
	for _, date := range []string{"2026-01-05", "2026-03-05"} {
		q.sessions[date] = q.insert("INSERT INTO training_sessions (date, timetable_id) VALUES (?, ?)", date, timetable)
		q.slots[date] = q.insert("INSERT INTO session_slots (session_id, instructor_id) VALUES (?, ?)", q.sessions[date], instructor)
	}
	return q
}

func (q *queueDB) insert(query string, args ...any) int64 {
	q.t.Helper()
	res, err := q.db.Exec(query, args...)
	if err != nil {
		q.t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func (q *queueDB) group(name, newMemberPriority string) int64 {
	return q.insert("INSERT INTO groups (name, new_member_priority) VALUES (?, ?)", name, newMemberPriority)
}

// member adds a student to group; joinedAt and inviteNextAt may be nil.
func (q *queueDB) member(name string, group int64, joinedAt, inviteNextAt any) int64 {
	id := q.insert("INSERT INTO students (first_name, last_name, email) VALUES (?, 'Test', ?)", name, name+"@test")
	q.insert("INSERT INTO student_groups (student_id, group_id, joined_at, invite_next_at) VALUES (?, ?, ?, ?)",
		id, group, joinedAt, inviteNextAt)
	return id
}

func (q *queueDB) invitation(student int64, sessionDate, status, invitedAt string) {
	q.tokens++
	q.insert(`INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token, status, invited_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		q.sessions[sessionDate], student, q.timeslot, q.slots[sessionDate], "t"+strconv.Itoa(q.tokens), status, invitedAt)
}

// TestQueuePosition pins the ordering rule of queue.sql: pending "invite next" overrides
// first, then by queue_at (empty first); equal keys share a position.
func TestQueuePosition(t *testing.T) {
	q := newQueueDB(t)
	back := q.group("Back", "back")
	front := q.group("Front", "front")

	inviteNext := q.member("InviteNext", back, nil, "2026-02-10 00:00:00")
	q.invitation(inviteNext, "2026-01-05", "confirmed", "2026-01-04 10:00:00") // before the override: still pending

	q.member("Never", back, nil, nil)
	declined := q.member("Declined", back, nil, nil)
	q.invitation(declined, "2026-03-05", "declined", "2026-03-01 10:00:00") // not a counted turn
	q.member("JoinedFront", front, "2026-02-01 12:00:00", nil)              // 'front' policy ignores joining

	oldTurn := q.member("OldTurn", back, nil, nil)
	q.invitation(oldTurn, "2026-01-05", "confirmed", "2026-01-04 10:00:00")

	q.member("JoinedBack", back, "2026-02-01 12:00:00", nil)

	recentTurn := q.member("RecentTurn", back, nil, nil)
	q.invitation(recentTurn, "2026-03-05", "invited", "2026-03-01 10:00:00")
	usedInviteNext := q.member("UsedInviteNext", back, nil, "2026-01-01 00:00:00")
	q.invitation(usedInviteNext, "2026-03-05", "scheduled", "2026-03-01 10:00:00") // after the override: used up

	members, err := LoadMembers(q.db)
	if err != nil {
		t.Fatal(err)
	}

	want := map[string]struct {
		position int64
		queueAt  string
		reason   string
	}{
		"InviteNext":     {1, "2026-01-05 00:00:00", ""},
		"Never":          {2, "", ""},
		"Declined":       {2, "", ""},
		"JoinedFront":    {2, "", ""},
		"OldTurn":        {3, "2026-01-05 00:00:00", ""},
		"JoinedBack":     {4, "2026-02-01 12:00:00", "joined"},
		"RecentTurn":     {5, "2026-03-05 00:00:00", ""},
		"UsedInviteNext": {5, "2026-03-05 00:00:00", ""},
	}
	if len(members) != len(want) {
		t.Fatalf("got %d members, want %d", len(members), len(want))
	}
	for _, m := range members {
		w := want[m.FirstName]
		reason := ""
		if m.QueueReason != nil {
			reason = *m.QueueReason
		}
		if m.QueuePosition != w.position || m.QueueAt != w.queueAt || reason != w.reason {
			t.Errorf("%s: position %d, queue_at %q, reason %q; want %d, %q, %q",
				m.FirstName, m.QueuePosition, m.QueueAt, reason, w.position, w.queueAt, w.reason)
		}
	}
}

// TestMemberMatchesQuery checks that queue.sql selects exactly Member's columns. The scan only
// fails on a column without a field; a field without a column would silently stay zero.
func TestMemberMatchesQuery(t *testing.T) {
	q := newQueueDB(t)
	rows, err := q.db.Query(membersQuery)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}

	var fields []string
	for f := range reflect.TypeFor[Member]().Fields() {
		fields = append(fields, f.Tag.Get("db"))
	}
	slices.Sort(columns)
	slices.Sort(fields)
	if !slices.Equal(columns, fields) {
		t.Fatalf("queue.sql columns %v, Member db fields %v", columns, fields)
	}
}

// --- Sort and WeightedPickGroup -----------------------------------------------------------

// member is a Member with only an id and a queue position.
func member(id, position int64) Member {
	return Member{ID: id, QueuePosition: position}
}

// The expected orders pin the hash-based shuffle: a change to it reorders existing queues.
func TestSort(t *testing.T) {
	rows := []Member{
		member(1, 2), member(2, 2), member(3, 2),
		member(4, 3), member(5, 1), member(6, 1),
		member(7, 3), member(8, 3),
	}
	want := map[int64][]int64{
		1:  {6, 5, 2, 3, 1, 7, 4, 8},
		7:  {5, 6, 3, 2, 1, 4, 7, 8},
		99: {6, 5, 3, 1, 2, 7, 8, 4},
	}
	for seed, expected := range want {
		sorted := slices.Clone(rows)
		Sort(sorted, seed)
		var got []int64
		for _, r := range sorted {
			got = append(got, r.ID)
		}
		if !reflect.DeepEqual(got, expected) {
			t.Errorf("seed %d: got %v, want %v", seed, got, expected)
		}
	}
}

// scripted returns a random source that yields the given values in order.
func scripted(values ...float64) func() float64 {
	return func() float64 {
		v := values[0]
		values = values[1:]
		return v
	}
}

func TestWeightedPickGroup(t *testing.T) {
	weights := map[int64]float64{1: 70, 2: 30, 3: 0, 5: -10}

	tests := []struct {
		name   string
		groups []int64
		draw   float64
		want   int64
	}{
		// Weighted: group 1 covers [0, 0.7), group 2 covers [0.7, 1); zero and negative weights are never picked.
		{"weighted start", []int64{1, 2, 3}, 0, 1},
		{"weighted just below boundary", []int64{1, 2, 3}, 0.6999, 1},
		{"weighted at boundary", []int64{1, 2, 3}, 0.7, 2},
		{"weighted end", []int64{1, 2, 3}, 0.9999, 2},
		{"zero weight first", []int64{3, 1}, 0, 1},
		{"negative weight first", []int64{5, 2}, 0, 2},
		// Uniform: all weights zero or missing, so each group gets an equal share.
		{"uniform first", []int64{3, 4}, 0.4999, 3},
		{"uniform second", []int64{3, 4}, 0.5, 4},
		{"uniform last", []int64{3, 4, 6}, 0.9999, 6},
	}
	for _, tc := range tests {
		if got := WeightedPickGroup(tc.groups, weights, scripted(tc.draw)); got != tc.want {
			t.Errorf("%s: draw %v picked %d, want %d", tc.name, tc.draw, got, tc.want)
		}
	}
}
