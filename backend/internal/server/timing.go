package server

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
)

// Invitation timing.

const defaultTimeZone = "Europe/Amsterdam"

// expiryMinutes reads invitation_expiry_minutes. Non-numeric values (NaN included) mean 0:
// no time-based expiry.
func expiryMinutes(q db.Querier) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(db.Setting(q, "invitation_expiry_minutes", "120")), 64)
	if err != nil || math.IsNaN(v) {
		return 0
	}
	return v
}

func clubLocation(q db.Querier) *time.Location {
	tz := db.Setting(q, "timezone", defaultTimeZone)
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	loc, _ := time.LoadLocation(defaultTimeZone)
	return loc
}

// computeExpiresAt adds whole minutes to invited_at, a datetime('now') value
// ("YYYY-MM-DD HH:MM:SS", UTC). Date#setMinutes truncates, so the minutes do too.
func computeExpiresAt(invitedAt string, minutes float64) (time.Time, bool) {
	t, err := time.Parse(time.DateTime, invitedAt)
	if err != nil {
		return time.Time{}, false
	}
	return t.Add(time.Duration(math.Trunc(minutes)) * time.Minute), true
}

// slotStart interprets session date + start time as wall-clock time in the club's zone.
func slotStart(sessionDate, startTime string, loc *time.Location) (time.Time, bool) {
	d, err := time.Parse(time.DateOnly, sessionDate)
	if err != nil {
		return time.Time{}, false
	}
	hh, mm, ok := strings.Cut(startTime, ":")
	if !ok {
		return time.Time{}, false
	}
	h, err1 := strconv.Atoi(hh)
	m, err2 := strconv.Atoi(mm)
	if err1 != nil || err2 != nil {
		return time.Time{}, false
	}
	return time.Date(d.Year(), d.Month(), d.Day(), h, m, 0, 0, loc), true
}

// invitationDeadline is the earlier of invited_at + expiry and the slot start.
func invitationDeadline(invitedAt, sessionDate, startTime string, minutes float64, loc *time.Location) (time.Time, bool) {
	start, ok := slotStart(sessionDate, startTime, loc)
	if !ok {
		return time.Time{}, false
	}
	if minutes <= 0 {
		return start, true
	}
	if byMinutes, ok := computeExpiresAt(invitedAt, minutes); ok && byMinutes.Before(start) {
		return byMinutes, true
	}
	return start, true
}

// invitationTiming is the subset of an invitation row the timing functions read.
type invitationTiming struct {
	Status      string `db:"status"`
	InvitedAt   string `db:"invited_at"`
	SessionDate string `db:"session_date"`
	StartTime   string `db:"start_time"`
}

// effectiveStatus is the status as it should be shown, even if the expiry timer has not fired yet.
func effectiveStatus(inv invitationTiming, minutes float64, loc *time.Location, now time.Time) string {
	if inv.Status != "invited" {
		return inv.Status
	}
	if start, ok := slotStart(inv.SessionDate, inv.StartTime, loc); ok && !now.Before(start) {
		return "invalidated"
	}
	if minutes > 0 && inv.InvitedAt != "" {
		if exp, ok := computeExpiresAt(inv.InvitedAt, minutes); ok && now.After(exp) {
			return "expired"
		}
	}
	return "invited"
}

// dayOfWeek mirrors new Date(date + 'T00:00:00').getDay().
func dayOfWeek(date string) (int, bool) {
	d, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return 0, false
	}
	return int(d.Weekday()), true
}
