package email

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/golden-*.html from the current output")

// TestEmailsMatchGolden compares each rendered email with testdata/golden-<i>.html. After an
// intended change to the templates, run `go test ./internal/email -update` and review the diff.
func TestEmailsMatchGolden(t *testing.T) {
	type sent struct{ subject, text, html string }
	var got []sent
	m := &Mailer{cfg: Config{FrontendURL: "http://example.test"}}
	m.capture = func(_, subject, text, html string) { got = append(got, sent{subject, text, html}) }

	const club = `Club "A&B" <Test>`
	for _, locale := range []string{"en", "nl"} {
		m.SendInvitation(InvitationParams{To: "x@y.z", StudentName: "Jan & <Piet>", Date: "2026-10-16", Token: "tok-123", ClubName: club, Locale: locale})
		m.SendConfirmation(SessionParams{To: "x@y.z", StudentName: "Jan", Date: "2026-01-04", StartTime: "19:30", DisciplineName: "Pistool & Geweer", ClubName: club, Locale: locale}, "tok-456")
		m.SendCancellation(SessionParams{To: "x@y.z", StudentName: "Jan", Date: "2026-05-31", StartTime: "20:00", ClubName: club, Locale: locale})
		m.SendAdminCancellation(SessionParams{To: "x@y.z", StudentName: "Jan", Date: "2026-12-25", StartTime: "21:15", DisciplineName: "Revolver", ClubName: club, Locale: locale})
	}

	for i, g := range got {
		file := fmt.Sprintf("testdata/golden-%d.html", i)
		if *update {
			if err := os.WriteFile(file, []byte(g.html), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if g.html != string(want) {
			t.Errorf("email %d (%s): HTML differs from %s\n%s", i, g.subject, file, firstDiff(g.html, string(want)))
		}
	}
	if len(got) != 8 {
		t.Fatalf("rendered %d emails, want 8", len(got))
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

func firstDiff(a, b string) string {
	n := min(len(a), len(b))
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			lo := max(0, i-80)
			return fmt.Sprintf("got:    …%s…\ngolden: …%s…", a[lo:min(len(a), i+80)], b[lo:min(len(b), i+80)])
		}
	}
	return fmt.Sprintf("length go=%d ts=%d", len(a), len(b))
}
