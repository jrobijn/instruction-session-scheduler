package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// sendInvitations generates the schedule and sends the invitations through the admin API.
func (f *scheduleFixture) sendInvitations() map[string]any {
	f.t.Helper()
	f.generate().status(http.StatusOK)
	return f.admin(http.MethodPost, fmt.Sprintf("/api/sessions/%d/send-invitations", f.sessionID), nil).status(http.StatusOK).object()
}

// invitationOf returns the latest invitation of the named student in the fixture's session.
func (f *scheduleFixture) invitationOf(firstName string) map[string]any {
	f.t.Helper()
	row := f.row(`
		SELECT inv.* FROM invitations inv JOIN students s ON s.id = inv.student_id
		WHERE inv.session_id = ? AND s.first_name = ? ORDER BY inv.id DESC LIMIT 1`, f.sessionID, firstName)
	if row == nil {
		f.t.Fatalf("no invitation for %s", firstName)
	}
	return row
}

func (f *scheduleFixture) tokenOf(firstName string) string {
	f.t.Helper()
	return f.invitationOf(firstName)["token"].(string)
}

func (f *scheduleFixture) invitationAction(firstName, action string, body any) *response {
	f.t.Helper()
	return f.public(http.MethodPost, "/api/invitations/"+f.tokenOf(firstName)+"/"+action, body)
}

func (f *scheduleFixture) statusOf(firstName string) string {
	f.t.Helper()
	return f.invitationOf(firstName)["status"].(string)
}

func (e *testEnv) notificationTypes() []string {
	e.t.Helper()
	var out []string
	for _, r := range e.rows("SELECT type FROM notifications ORDER BY id") {
		out = append(out, r["type"].(string))
	}
	return out
}

func (e *testEnv) hasTimer(invitationID int64) bool {
	e.srv.timers.mu.Lock()
	defer e.srv.timers.mu.Unlock()
	_, ok := e.srv.timers.timers[invitationID]
	return ok
}

func (e *testEnv) groupDiscipline(groupID int64) int64 {
	e.t.Helper()
	return toInt64(e.row("SELECT discipline_id FROM discipline_groups WHERE group_id = ?", groupID)["discipline_id"])
}

// invitedPair is a session with one instructor and timeslots 18:00 and 19:00, where A and B
// are invited (A at 18:00) and C and D wait in the same group.
func invitedPair(t *testing.T) (*scheduleFixture, int64) {
	t.Helper()
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	for _, n := range []string{"A", "B", "C", "D"} {
		f.student(n, g)
	}
	f.sendInvitations()
	return f, g
}

// --- sending ----------------------------------------------------------------------------

func TestSendInvitations(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	a := f.student("A", g)
	b := f.student("B", g)
	f.student("C", g)

	res := f.sendInvitations()
	if res["sent"] != 2.0 || len(res["errors"].([]any)) != 0 {
		t.Fatalf("send-invitations = %v", res)
	}
	for _, sid := range []int64{a, b} {
		mail := f.mailTo(f.studentEmail(sid))
		if len(mail) != 1 {
			t.Fatalf("student %d got %d emails, want 1", sid, len(mail))
		}
		inv := f.row("SELECT * FROM invitations WHERE student_id = ?", sid)
		if inv["status"] != "invited" || inv["email_sent"] != int64(1) {
			t.Fatalf("invitation after sending: %v", inv)
		}
		if !strings.Contains(mail[0].Text, inv["token"].(string)) {
			t.Fatalf("invitation email does not contain the token link:\n%s", mail[0].Text)
		}
		if !f.hasTimer(toInt64(inv["id"])) {
			t.Fatalf("no expiry timer for invitation %v", inv["id"])
		}
	}
	if len(f.sentMail()) != 2 {
		t.Fatalf("sent %d emails, want 2", len(f.sentMail()))
	}
	if st := f.row("SELECT status FROM training_sessions WHERE id = ?", f.sessionID)["status"]; st != "invitations_sent" {
		t.Fatalf("session status = %v", st)
	}

	again := f.admin(http.MethodPost, fmt.Sprintf("/api/sessions/%d/send-invitations", f.sessionID), nil).status(http.StatusOK).object()
	if again["sent"] != 0.0 || again["message"] != "No pending invitations to send" {
		t.Fatalf("second send = %v", again)
	}
	if len(f.sentMail()) != 2 {
		t.Fatal("second send emailed students again")
	}
}

// --- viewing ----------------------------------------------------------------------------

func TestGetInvitation(t *testing.T) {
	f, _ := invitedPair(t)
	f.exec("UPDATE training_sessions SET notes = 'Bring a helmet' WHERE id = ?", f.sessionID)
	f.setSetting("club_name", "Test Club")

	got := f.public(http.MethodGet, "/api/invitations/"+f.tokenOf("A"), nil).status(http.StatusOK).object()
	for k, want := range map[string]any{
		"student_name": "A Test", "date": sessionDate, "start_time": "18:00", "notes": "Bring a helmet",
		"status": "invited", "session_status": "invitations_sent", "discipline_name": nil,
		"club_name": "Test Club", "locale": "en",
	} {
		if got[k] != want {
			t.Errorf("%s = %#v, want %#v", k, got[k], want)
		}
	}
	if _, err := time.Parse(time.RFC3339, got["expires_at"].(string)); err != nil {
		t.Errorf("expires_at = %v: %v", got["expires_at"], err)
	}

	f.public(http.MethodGet, "/api/invitations/nope", nil).wantError(http.StatusNotFound, "Invitation not found")
}

func TestGetInvitationShowsEffectiveStatus(t *testing.T) {
	f, _ := invitedPair(t)
	f.exec("UPDATE invitations SET invited_at = '2030-01-01 10:00:00'")

	pinClock(t, utc("2030-01-01 13:00:00")) // 3h after invited, default expiry is 2h
	got := f.public(http.MethodGet, "/api/invitations/"+f.tokenOf("A"), nil).status(http.StatusOK).object()
	if got["status"] != "expired" || got["expires_at"] != nil {
		t.Fatalf("status = %v, expires_at = %v; want expired without expires_at", got["status"], got["expires_at"])
	}
	// The stored status is untouched; the expiry timer does that.
	if st := f.statusOf("A"); st != "invited" {
		t.Fatalf("stored status = %s", st)
	}
}

// --- confirming -------------------------------------------------------------------------

func TestConfirmInvitation(t *testing.T) {
	f, g := invitedPair(t)
	discipline := f.groupDiscipline(g)
	invID := toInt64(f.invitationOf("A")["id"])

	res := f.invitationAction("A", "confirm", map[string]any{"discipline_id": discipline}).status(http.StatusOK).object()
	if res["success"] != true {
		t.Fatalf("confirm = %v", res)
	}
	inv := f.invitationOf("A")
	if inv["status"] != "confirmed" || toInt64(inv["discipline_id"]) != discipline || inv["responded_at"] == nil {
		t.Fatalf("invitation after confirm: %v", inv)
	}
	if f.hasTimer(invID) {
		t.Fatal("expiry timer still set after confirm")
	}
	if got := f.notificationTypes(); len(got) != 1 || got[0] != "invitation_confirmed" {
		t.Fatalf("notifications = %v", got)
	}
	if mail := f.mailTo(f.row("SELECT email FROM students WHERE first_name = 'A'")["email"].(string)); len(mail) != 2 {
		t.Fatalf("A got %d emails, want invitation + confirmation", len(mail))
	}

	f.invitationAction("A", "confirm", nil).wantError(http.StatusBadRequest, "Invitation already confirmed")
}

func TestConfirmLastSpotNotifiesSessionFull(t *testing.T) {
	f, _ := invitedPair(t)
	f.invitationAction("A", "confirm", nil).status(http.StatusOK)
	f.invitationAction("B", "confirm", nil).status(http.StatusOK)
	got := f.notificationTypes()
	want := []string{"invitation_confirmed", "invitation_confirmed", "session_full"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("notifications = %v, want %v", got, want)
	}
}

func TestConfirmRejectsDisciplineOfOtherGroup(t *testing.T) {
	f, _ := invitedPair(t)
	other := f.group("Seniors")
	f.invitationAction("A", "confirm", map[string]any{"discipline_id": f.groupDiscipline(other)}).
		wantError(http.StatusBadRequest, "Selected discipline is not available for your group")
	if st := f.statusOf("A"); st != "invited" {
		t.Fatalf("status = %s, want invited", st)
	}
}

func TestInvitationActionsRefusedWhenClosed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		setup  func(t *testing.T, f *scheduleFixture)
		action string
		msg    string
	}{
		{"unknown token", nil, "", "Invitation not found"},
		{"expired", func(t *testing.T, f *scheduleFixture) {
			f.exec("UPDATE invitations SET invited_at = '2030-01-01 10:00:00'")
			pinClock(t, utc("2030-01-01 12:00:01"))
		}, "confirm", "This invitation has expired"},
		{"slot started", func(t *testing.T, f *scheduleFixture) {
			pinClock(t, utc(sessionDate+" 17:00:00")) // 18:00 Amsterdam
		}, "decline", "This time slot has already started"},
		{"session completed", func(t *testing.T, f *scheduleFixture) {
			f.exec("UPDATE training_sessions SET status = 'completed'")
		}, "confirm", "This session has already passed"},
		{"cancel before confirming", nil, "cancel", "Cannot cancel — invitation is invited"},
		{"decline after declining", func(t *testing.T, f *scheduleFixture) {
			f.invitationAction("A", "decline", nil).status(http.StatusOK)
		}, "decline", "Invitation already declined"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _ := invitedPair(t)
			if tc.setup != nil {
				tc.setup(t, f)
			}
			if tc.action == "" {
				f.public(http.MethodPost, "/api/invitations/unknown/confirm", nil).wantError(http.StatusNotFound, tc.msg)
				return
			}
			before := f.statusOf("A")
			f.invitationAction("A", tc.action, nil).wantError(http.StatusBadRequest, tc.msg)
			if after := f.statusOf("A"); after != before {
				t.Fatalf("status changed from %s to %s", before, after)
			}
		})
	}
}

// --- declining and replacements ---------------------------------------------------------

func TestDeclineInvitesReplacement(t *testing.T) {
	f, g := invitedPair(t)
	declined := f.invitationOf("A")

	res := f.invitationAction("A", "decline", nil).status(http.StatusOK).object()
	repl, _ := res["replacement"].(map[string]any)
	if repl["name"] != "C Test" {
		t.Fatalf("replacement = %v, want C (first in queue)", res["replacement"])
	}
	if st := f.statusOf("A"); st != "declined" {
		t.Fatalf("A status = %s", st)
	}
	if f.hasTimer(toInt64(declined["id"])) {
		t.Fatal("declined invitation still has an expiry timer")
	}

	c := f.invitationOf("C")
	if c["status"] != "invited" || c["email_sent"] != int64(1) || toInt64(c["group_id"]) != g {
		t.Fatalf("replacement invitation: %v", c)
	}
	if c["timeslot_id"] != declined["timeslot_id"] || c["slot_id"] != declined["slot_id"] {
		t.Fatal("replacement did not take the vacated spot")
	}
	if !f.hasTimer(toInt64(c["id"])) {
		t.Fatal("replacement has no expiry timer")
	}
	if len(f.mailTo(repl["email"].(string))) != 1 {
		t.Fatal("replacement was not emailed")
	}
	var log map[string]any
	json.Unmarshal([]byte(c["decision_log"].(string)), &log)
	for k, want := range map[string]any{
		"trigger": "replacement", "replaced_student": "A Test", "replacement_reason": "invited",
		"same_group_match": true, "group_name": "Juniors",
	} {
		if log[k] != want {
			t.Errorf("decision_log[%s] = %v, want %v", k, log[k], want)
		}
	}
	if got := f.notificationTypes(); len(got) != 1 || got[0] != "invitation_declined" {
		t.Fatalf("notifications = %v", got)
	}

	// The next decline moves on to D; A, who declined, is not invited again.
	f.invitationAction("C", "decline", nil).status(http.StatusOK)
	if st := f.statusOf("D"); st != "invited" {
		t.Fatalf("D status = %s, want invited", st)
	}
	res = f.invitationAction("D", "decline", nil).status(http.StatusOK).object()
	if res["replacement"] != nil {
		t.Fatalf("replacement = %v, want none left", res["replacement"])
	}
}

func TestReplacementSkipsStudentsPreferringOtherTimeslots(t *testing.T) {
	f, _ := invitedPair(t)
	c := f.row("SELECT id FROM students WHERE first_name = 'C'")["id"].(int64)
	f.preferTimeslots(c, f.timetable, f.timeslots[1]) // A's spot is 18:00

	res := f.invitationAction("A", "decline", nil).status(http.StatusOK).object()
	if repl := res["replacement"].(map[string]any); repl["name"] != "D Test" {
		t.Fatalf("replacement = %v, want D", repl)
	}
}

func TestReplacementFallsBackToOtherGroup(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	a := f.groupIn("A", 100)
	b := f.groupIn("B", 0)
	f.student("A1", a)
	f.student("B1", b)
	f.sendInvitations()

	res := f.invitationAction("A1", "decline", nil).status(http.StatusOK).object()
	if repl, _ := res["replacement"].(map[string]any); repl == nil || repl["name"] != "B1 Test" {
		t.Fatalf("replacement = %v, want B1", res["replacement"])
	}
	var log map[string]any
	json.Unmarshal([]byte(f.invitationOf("B1")["decision_log"].(string)), &log)
	if log["same_group_match"] != false || log["group_name"] != "B" {
		t.Fatalf("decision_log = %v", log)
	}
	if toInt64(f.invitationOf("B1")["group_id"]) != b {
		t.Fatal("replacement should be recorded in its own group")
	}
}

func TestReplacementSkipsGroupsOutsideTimetable(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	a := f.groupIn("A", 100)
	f.student("A1", a)
	f.student("Outsider", f.group("NotInTimetable"))
	f.sendInvitations()

	res := f.invitationAction("A1", "decline", nil).status(http.StatusOK).object()
	if res["replacement"] != nil {
		t.Fatalf("replacement = %v, want none", res["replacement"])
	}
}

// --- cancelling a confirmed invitation --------------------------------------------------

func TestCancelConfirmedInvitation(t *testing.T) {
	f, _ := invitedPair(t)
	f.invitationAction("A", "confirm", nil).status(http.StatusOK)
	f.invitationAction("B", "confirm", nil).status(http.StatusOK)
	aEmail := f.row("SELECT email FROM students WHERE first_name = 'A'")["email"].(string)

	res := f.invitationAction("A", "cancel", nil).status(http.StatusOK).object()
	if st := f.statusOf("A"); st != "cancelled" {
		t.Fatalf("A status = %s", st)
	}
	if repl, _ := res["replacement"].(map[string]any); repl == nil || repl["name"] != "C Test" {
		t.Fatalf("replacement = %v, want C", res["replacement"])
	}
	if n := len(f.mailTo(aEmail)); n != 3 {
		t.Fatalf("A got %d emails, want invitation, confirmation and cancellation", n)
	}
	got := strings.Join(f.notificationTypes(), ",")
	want := "invitation_confirmed,invitation_confirmed,session_full,invitation_cancelled,session_no_longer_full"
	if got != want {
		t.Fatalf("notifications = %s, want %s", got, want)
	}
	var log map[string]any
	json.Unmarshal([]byte(f.invitationOf("C")["decision_log"].(string)), &log)
	if log["replacement_reason"] != "confirmed" {
		t.Fatalf("replacement_reason = %v, want the status at cancel time", log["replacement_reason"])
	}
}
