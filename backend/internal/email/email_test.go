package email

import (
	"strings"
	"testing"
)

// TestEmailHTML checks, for every email in both locales, what the HTML must get right:
// user input is escaped, the invitation link is present, and the locale is applied.
func TestEmailHTML(t *testing.T) {
	const (
		club       = `Club "A&B" <Club>`
		student    = `Jan & <Piet>`
		discipline = `Pistool & <Geweer>`
	)
	session := SessionParams{To: "x@y.z", StudentName: student, Date: "2026-10-16", StartTime: "19:30",
		DisciplineName: discipline, ClubName: club}

	cases := []struct {
		name, locale, subject, date, url string
		send                             func(*Mailer, string)
	}{
		{"invitation", "en", "Instruction Session Invitation — " + club, "Friday, 16 October 2026", "http://example.test/invitation/tok-inv",
			func(m *Mailer, l string) {
				m.SendInvitation(InvitationParams{To: "x@y.z", StudentName: student, Date: "2026-10-16", Token: "tok-inv", ClubName: club, Locale: l})
			}},
		{"invitation", "nl", "Uitnodiging instructiesessie — " + club, "vrijdag 16 oktober 2026", "http://example.test/invitation/tok-inv",
			func(m *Mailer, l string) {
				m.SendInvitation(InvitationParams{To: "x@y.z", StudentName: student, Date: "2026-10-16", Token: "tok-inv", ClubName: club, Locale: l})
			}},
		{"confirmation", "en", "Instruction Session Confirmed — " + club, "Friday, 16 October 2026", "http://example.test/invitation/tok-conf",
			func(m *Mailer, l string) { p := session; p.Locale = l; m.SendConfirmation(p, "tok-conf") }},
		{"confirmation", "nl", "Instructiesessie bevestigd — " + club, "vrijdag 16 oktober 2026", "http://example.test/invitation/tok-conf",
			func(m *Mailer, l string) { p := session; p.Locale = l; m.SendConfirmation(p, "tok-conf") }},
		{"cancellation", "en", "Instruction Session Cancelled — " + club, "Friday, 16 October 2026", "",
			func(m *Mailer, l string) { p := session; p.Locale = l; m.SendCancellation(p) }},
		{"cancellation", "nl", "Instructiesessie geannuleerd — " + club, "vrijdag 16 oktober 2026", "",
			func(m *Mailer, l string) { p := session; p.Locale = l; m.SendCancellation(p) }},
		{"admin cancellation", "en", "Instruction Session Invitation Withdrawn — " + club, "Friday, 16 October 2026", "",
			func(m *Mailer, l string) { p := session; p.Locale = l; m.SendAdminCancellation(p) }},
		{"admin cancellation", "nl", "Instructiesessie uitnodiging ingetrokken — " + club, "vrijdag 16 oktober 2026", "",
			func(m *Mailer, l string) { p := session; p.Locale = l; m.SendAdminCancellation(p) }},
	}

	for _, c := range cases {
		t.Run(c.name+"/"+c.locale, func(t *testing.T) {
			var subject, body string
			m := &Mailer{cfg: Config{FrontendURL: "http://example.test"}}
			m.capture = func(_, s, _, h string) { subject, body = s, h }
			c.send(m, c.locale)

			if subject != c.subject {
				t.Errorf("subject = %q, want %q", subject, c.subject)
			}
			for _, raw := range []string{"<Club>", "<Piet>", "<Geweer>", `"A&B"`, "Jan & ", "Pistool & "} {
				if strings.Contains(body, raw) {
					t.Errorf("HTML contains unescaped %q", raw)
				}
			}

			escaped := []string{"Club &#34;A&amp;B&#34; &lt;Club&gt;", "Jan &amp; &lt;Piet&gt;"}
			if c.name != "invitation" {
				escaped = append(escaped, "Pistool &amp; &lt;Geweer&gt;")
			}

			for _, want := range escaped {
				if !strings.Contains(body, want) {
					t.Errorf("HTML lacks escaped %q", want)
				}
			}

			if !strings.Contains(body, `<html lang="`+c.locale+`">`) {
				t.Errorf("HTML lacks lang=%q", c.locale)
			}
			if !strings.Contains(body, c.date) {
				t.Errorf("HTML lacks date %q", c.date)
			}

			if c.url == "" {
				if strings.Contains(body, "/invitation/") {
					t.Error("HTML contains an invitation link")
				}

				return
			}

			// The button and the copy-link line both link to it; the latter also shows it.
			if n := strings.Count(body, `href="`+c.url+`"`); n != 2 {
				t.Errorf("HTML links to %s %d times, want 2", c.url, n)
			}
			if !strings.Contains(body, ">"+c.url+"</a>") {
				t.Errorf("HTML does not show %s as link text", c.url)
			}
		})
	}
}

func TestEmailText(t *testing.T) {
	var text string
	m := &Mailer{capture: func(_, _, tx, _ string) { text = tx }}
	m.SendConfirmation(SessionParams{StudentName: "Jan", Date: "2026-01-04", StartTime: "19:30", DisciplineName: "Revolver", ClubName: "Club", Locale: "en"}, "t")
	want := "Hi Jan,\n\nYour attendance has been confirmed for the instruction session at Club.\n\n" +
		"Date: Sunday, 4 January 2026\nTime: 19:30\nDiscipline: Revolver\n\n" +
		"If you can no longer attend, please cancel your participation using the link below so another student can take your place:\n" +
		"http://localhost:5173/invitation/t\n\nSee you at the training!\nClub"
	if text != want {
		t.Errorf("text:\n%q\nwant\n%q", text, want)
	}
}

func TestFormatDate(t *testing.T) {
	cases := map[string]string{
		"en|2026-10-16": "Friday, 16 October 2026",
		"en|2026-01-04": "Sunday, 4 January 2026",
		"nl|2026-10-16": "vrijdag 16 oktober 2026",
		"nl|2026-05-31": "zondag 31 mei 2026",
		"en|not-a-date": "not-a-date",
	}
	for in, want := range cases {
		locale, date, _ := strings.Cut(in, "|")
		if got := FormatDate(date, locale); got != want {
			t.Errorf("FormatDate(%s, %s) = %q, want %q", date, locale, got, want)
		}
	}
}
