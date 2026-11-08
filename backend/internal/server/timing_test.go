package server

import (
	"testing"
	"time"
)

func amsterdam(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Amsterdam")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func utc(s string) time.Time {
	t, err := time.Parse(time.DateTime, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestSlotStart(t *testing.T) {
	loc := amsterdam(t)
	for _, tc := range []struct {
		date, start string
		want        string // UTC, empty for invalid
	}{
		{"2030-01-07", "18:00", "2030-01-07 17:00:00"}, // CET, UTC+1
		{"2030-07-01", "18:30", "2030-07-01 16:30:00"}, // CEST, UTC+2
		{"2030-01-07", "9:05", "2030-01-07 08:05:00"},
		{"2030-01-07", "1800", ""},
		{"2030-01-07", "aa:00", ""},
		{"07-01-2030", "18:00", ""},
		{"", "18:00", ""},
	} {
		got, ok := slotStart(tc.date, tc.start, loc)
		if tc.want == "" {
			if ok {
				t.Errorf("slotStart(%q, %q) = %v, want invalid", tc.date, tc.start, got)
			}
			continue
		}
		if !ok || !got.Equal(utc(tc.want)) {
			t.Errorf("slotStart(%q, %q) = %v, %v; want %s UTC", tc.date, tc.start, got.UTC(), ok, tc.want)
		}
	}
}

func TestComputeExpiresAtTruncatesMinutes(t *testing.T) {
	got, ok := computeExpiresAt("2030-01-07 10:00:00", 90.9)
	if !ok || !got.Equal(utc("2030-01-07 11:30:00")) {
		t.Fatalf("got %v, %v", got, ok)
	}
	if _, ok := computeExpiresAt("not a time", 10); ok {
		t.Fatal("invalid invited_at should not parse")
	}
}

func TestInvitationDeadline(t *testing.T) {
	loc := amsterdam(t)
	// Slot starts 2030-01-07 17:00 UTC.
	for _, tc := range []struct {
		name      string
		invitedAt string
		minutes   float64
		want      string
	}{
		{"expiry before slot", "2030-01-07 10:00:00", 120, "2030-01-07 12:00:00"},
		{"slot before expiry", "2030-01-07 16:00:00", 120, "2030-01-07 17:00:00"},
		{"expiry equals slot", "2030-01-07 15:00:00", 120, "2030-01-07 17:00:00"},
		{"no time-based expiry", "2030-01-07 10:00:00", 0, "2030-01-07 17:00:00"},
		{"negative expiry", "2030-01-07 10:00:00", -5, "2030-01-07 17:00:00"},
		{"unparsable invited_at", "garbage", 120, "2030-01-07 17:00:00"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := invitationDeadline(tc.invitedAt, "2030-01-07", "18:00", tc.minutes, loc)
			if !ok || !got.Equal(utc(tc.want)) {
				t.Fatalf("got %v, %v; want %s UTC", got.UTC(), ok, tc.want)
			}
		})
	}
	if _, ok := invitationDeadline("2030-01-07 10:00:00", "bad", "18:00", 120, loc); ok {
		t.Fatal("invalid session date should have no deadline")
	}
}

func TestEffectiveStatus(t *testing.T) {
	loc := amsterdam(t)
	inv := invitationTiming{Status: "invited", InvitedAt: "2030-01-07 10:00:00", SessionDate: "2030-01-07", StartTime: "18:00"}
	for _, tc := range []struct {
		name    string
		mutate  func(*invitationTiming)
		minutes float64
		now     string
		want    string
	}{
		{"within window", nil, 120, "2030-01-07 11:59:59", "invited"},
		{"exactly at expiry", nil, 120, "2030-01-07 12:00:00", "invited"},
		{"after expiry", nil, 120, "2030-01-07 12:00:01", "expired"},
		{"slot started wins over expired", nil, 120, "2030-01-07 17:00:00", "invalidated"},
		{"just before slot, no expiry", nil, 0, "2030-01-07 16:59:59", "invited"},
		{"no invited_at never expires by time", func(i *invitationTiming) { i.InvitedAt = "" }, 120, "2030-01-07 16:00:00", "invited"},
		{"other statuses pass through", func(i *invitationTiming) { i.Status = "confirmed" }, 120, "2030-01-08 00:00:00", "confirmed"},
		{"scheduled is not expired", func(i *invitationTiming) { i.Status = "scheduled" }, 120, "2030-01-08 00:00:00", "scheduled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i := inv
			if tc.mutate != nil {
				tc.mutate(&i)
			}
			if got := effectiveStatus(i, tc.minutes, loc, utc(tc.now)); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExpiresAtISO(t *testing.T) {
	loc := amsterdam(t)
	inv := invitationTiming{Status: "invited", InvitedAt: "2030-01-07 10:00:00", SessionDate: "2030-01-07", StartTime: "18:00"}
	if got := expiresAtISO(inv, 120, loc); got == nil || *got != "2030-01-07T12:00:00.000Z" {
		t.Fatalf("got %v", got)
	}
	confirmed := inv
	confirmed.Status = "confirmed"
	if got := expiresAtISO(confirmed, 120, loc); got != nil {
		t.Fatalf("confirmed invitation has expires_at %v", got)
	}
	notSent := inv
	notSent.InvitedAt = ""
	if got := expiresAtISO(notSent, 120, loc); got != nil {
		t.Fatalf("invitation without invited_at has expires_at %v", got)
	}
}

func TestDayOfWeek(t *testing.T) {
	for date, want := range map[string]int{"2030-01-06": 0, "2030-01-07": 1, "2030-01-12": 6} {
		if got, ok := dayOfWeek(date); !ok || got != want {
			t.Errorf("dayOfWeek(%s) = %d, %v; want %d", date, got, ok, want)
		}
	}
	if _, ok := dayOfWeek("2030-13-01"); ok {
		t.Error("invalid date accepted")
	}
}

func TestJSONMinutes(t *testing.T) {
	if got := jsonMinutes(120); got != int64(120) {
		t.Errorf("jsonMinutes(120) = %#v", got)
	}
	if got := jsonMinutes(1.5); got != 1.5 {
		t.Errorf("jsonMinutes(1.5) = %#v", got)
	}
}

func TestExpiryMinutesSetting(t *testing.T) {
	e := newTestEnv(t)
	for value, want := range map[string]float64{"120": 120, " 30 ": 30, "1.5": 1.5, "abc": 0, "NaN": 0, "": 120 /* empty falls back to the default */} {
		e.setSetting("invitation_expiry_minutes", value)
		if got := e.srv.expiryMinutes(); got != want {
			t.Errorf("expiryMinutes with %q = %v, want %v", value, got, want)
		}
	}
	e.exec("DELETE FROM settings WHERE key = 'invitation_expiry_minutes'")
	if got := e.srv.expiryMinutes(); got != 120 {
		t.Errorf("default expiryMinutes = %v, want 120", got)
	}
}

func TestClubLocationSetting(t *testing.T) {
	e := newTestEnv(t)
	for value, want := range map[string]string{
		"America/New_York": "America/New_York",
		"Not/AZone":        "Europe/Amsterdam",
		"Local":            "Europe/Amsterdam",
		"":                 "Europe/Amsterdam",
	} {
		e.setSetting("timezone", value)
		if got := e.srv.clubLocation().String(); got != want {
			t.Errorf("clubLocation with %q = %s, want %s", value, got, want)
		}
	}
}
