// Package email renders and sends the student emails.
package email

import (
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"log"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/textproto"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Config mirrors the SMTP_* environment variables.
type Config struct {
	Host, Port, User, Pass, From string
	Secure                       bool   // implicit TLS (SMTP_SECURE=true), otherwise STARTTLS when offered
	FrontendURL                  string // base for invitation links
	PreviewDir                   string // EMAIL_PREVIEW_DIR: save HTML of unsent emails here
}

type Mailer struct {
	cfg     Config
	enabled bool
	// sending allows one SMTP connection at a time, like the TS backend's nodemailer pool
	// with maxConnections: 1, so a batch of invitations does not open parallel logins.
	sending sync.Mutex
	// capture, when set (tests), receives every email instead of it being sent or logged.
	capture func(to, subject, text, html string)
	// rootCAs, when set (tests), replaces the system roots for verifying the SMTP server.
	rootCAs *x509.CertPool
}

func New(cfg Config) *Mailer {
	m := &Mailer{cfg: cfg, enabled: cfg.Host != "" && cfg.User != ""}
	if !m.enabled {
		log.Println("⚠ SMTP not configured — emails will be logged to console instead of sent.")
	}
	return m
}

// deliver sends in the background, like the TS version whose sendMail callback only logs
// failures: callers never see SMTP errors. Emails go out one after another.
func (m *Mailer) deliver(to, subject, text, htmlBody string, previewLines []string) {
	if m.capture != nil {
		m.capture(to, subject, text, htmlBody)
		return
	}
	if !m.enabled {
		for _, l := range previewLines {
			log.Println(l)
		}
		if m.cfg.PreviewDir != "" {
			if err := os.MkdirAll(m.cfg.PreviewDir, 0o755); err == nil {
				name := fmt.Sprintf("%d-%s.html", time.Now().UnixMilli(), strings.ToLower(nonAlnum.ReplaceAllString(subject, "-")))
				file := filepath.Join(m.cfg.PreviewDir, name)
				if err := os.WriteFile(file, []byte(htmlBody), 0o644); err == nil {
					log.Printf("   Saved preview: %s", file)
				}
			}
		}
		return
	}
	go func() {
		m.sending.Lock()
		defer m.sending.Unlock()
		if err := m.send(to, subject, text, htmlBody); err != nil {
			log.Printf("email to %s (%q) failed: %v", to, subject, err)
			return
		}
		log.Printf("Message sent to %s: %s", to, subject)
	}()
}

var nonAlnum = regexp.MustCompile(`(?i)[^a-z0-9]+`)

func (m *Mailer) send(to, subject, text, htmlBody string) error {
	from := m.cfg.From
	if from == "" {
		from = m.cfg.User
	}
	msg, err := buildMessage(from, to, subject, text, htmlBody)
	if err != nil {
		return err
	}

	c, err := m.connect(m.tlsConfig())
	if err != nil {
		return err
	}
	defer c.Close()
	if err := m.authenticate(c); err != nil {
		return err
	}
	if err := c.Mail(addressOnly(from)); err != nil {
		return err
	}
	if err := c.Rcpt(addressOnly(to)); err != nil {
		return err
	}
	wc, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := wc.Write(msg); err != nil {
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// addressOnly extracts "a@b" from "Name <a@b>".
func addressOnly(s string) string {
	if i, j := strings.LastIndex(s, "<"), strings.LastIndex(s, ">"); i >= 0 && j > i {
		return s[i+1 : j]
	}
	return strings.TrimSpace(s)
}

func buildMessage(from, to, subject, text, htmlBody string) ([]byte, error) {
	var b strings.Builder
	mw := multipart.NewWriter(&b)
	id := make([]byte, 12)
	rand.Read(id)
	domain := "localhost"
	if at := strings.LastIndex(addressOnly(from), "@"); at >= 0 {
		domain = addressOnly(from)[at+1:]
	}
	headers := []string{
		"From: " + from,
		"To: " + to,
		"Subject: " + mime.QEncoding.Encode("utf-8", subject),
		"Date: " + time.Now().Format(time.RFC1123Z),
		"Message-ID: <" + hex.EncodeToString(id) + "@" + domain + ">",
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="` + mw.Boundary() + `"`,
	}
	b.WriteString(strings.Join(headers, "\r\n") + "\r\n\r\n")
	for _, part := range []struct{ ctype, body string }{{"text/plain", text}, {"text/html", htmlBody}} {
		w, err := mw.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {part.ctype + "; charset=utf-8"},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		if err != nil {
			return nil, err
		}
		qp := quotedprintable.NewWriter(w)
		qp.Write([]byte(part.body))
		qp.Close()
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

// --- Public send functions -------------------------------------------------------------

type InvitationParams struct {
	To, StudentName, Date, Token, ClubName, Locale string
}

func (m *Mailer) SendInvitation(p InvitationParams) {
	locale := orEN(p.Locale)
	s := For(locale)
	url := m.frontendURL() + "/invitation/" + p.Token
	subject := f(s.InvitationSubject, p.ClubName)
	date := FormatDate(p.Date, locale)

	body := renderLayout(locale, subject, p.ClubName, strings.Join([]string{
		renderHeading(f(s.Greeting, p.StudentName)),
		renderParagraph(f(s.InvitationBody, escape(p.ClubName), escape(date))),
		renderParagraph(escape(s.InvitationCta)),
		renderButton(url, s.RespondButton, "primary"),
		renderCopyLink(s.CopyLink, url),
		renderSignoff(s.BestRegards, p.ClubName),
	}, ""))
	text := f(s.Greeting, p.StudentName) + "\n\n" + stripHTML(f(s.InvitationBody, p.ClubName, date)) + "\n\n" +
		s.InvitationCta + "\n" + url + "\n\n" + s.BestRegards + "\n" + p.ClubName

	m.deliver(p.To, subject, text, body, []string{
		fmt.Sprintf("📧 [Email Preview] To: %s | Subject: %s", p.To, subject),
		"   Link: " + url,
	})
}

// SessionParams describe the session in confirmation and cancellation emails.
type SessionParams struct {
	To, StudentName, Date, StartTime, DisciplineName, ClubName, Locale string
}

func (m *Mailer) SendConfirmation(p SessionParams, token string) {
	locale := orEN(p.Locale)
	s := For(locale)
	url := m.frontendURL() + "/invitation/" + token
	subject := f(s.ConfirmationSubject, p.ClubName)
	date := FormatDate(p.Date, locale)

	body := renderLayout(locale, subject, p.ClubName, strings.Join([]string{
		renderHeading(f(s.Greeting, p.StudentName)),
		renderParagraph(f(s.ConfirmationBody, escape(p.ClubName))),
		renderDetails(sessionRows(s, date, p.StartTime, p.DisciplineName), "success"),
		renderParagraph(escape(s.CancelExplanation)),
		renderButton(url, s.CancelButton, "secondary"),
		renderCopyLink(s.CopyLink, url),
		renderSignoff(s.SeeYou, p.ClubName),
	}, ""))
	text := f(s.Greeting, p.StudentName) + "\n\n" + stripHTML(f(s.ConfirmationBody, p.ClubName)) + "\n\n" +
		sessionText(s, date, p.StartTime, p.DisciplineName) + "\n" + s.CancelExplanation + "\n" + url + "\n\n" + s.SeeYou + "\n" + p.ClubName

	m.deliver(p.To, subject, text, body, []string{
		fmt.Sprintf("📧 [Confirmation Email Preview] To: %s | Subject: %s", p.To, subject),
		"   Cancel link: " + url,
	})
}

func (m *Mailer) SendCancellation(p SessionParams) {
	locale := orEN(p.Locale)
	s := For(locale)
	m.sendCancellationLike(p, f(s.CancellationSubject, p.ClubName), f(s.CancellationBody, escape(p.ClubName)),
		stripHTML(f(s.CancellationBody, p.ClubName)), "📧 [Cancellation Email Preview]")
}

func (m *Mailer) SendAdminCancellation(p SessionParams) {
	locale := orEN(p.Locale)
	s := For(locale)
	m.sendCancellationLike(p, f(s.AdminCancellationSubject, p.ClubName), f(s.AdminCancellationBody, escape(p.ClubName)),
		stripHTML(f(s.AdminCancellationBody, p.ClubName)), "📧 [Admin Cancellation Email Preview]")
}

func (m *Mailer) sendCancellationLike(p SessionParams, subject, bodyHTML, bodyText, previewLabel string) {
	locale := orEN(p.Locale)
	s := For(locale)
	date := FormatDate(p.Date, locale)
	body := renderLayout(locale, subject, p.ClubName, strings.Join([]string{
		renderHeading(f(s.Greeting, p.StudentName)),
		renderParagraph(bodyHTML),
		renderDetails(sessionRows(s, date, p.StartTime, p.DisciplineName), "danger"),
		renderSignoff(s.BestRegards, p.ClubName),
	}, ""))
	text := f(s.Greeting, p.StudentName) + "\n\n" + bodyText + "\n\n" +
		sessionText(s, date, p.StartTime, p.DisciplineName) + "\n" + s.BestRegards + "\n" + p.ClubName
	m.deliver(p.To, subject, text, body, []string{fmt.Sprintf("%s To: %s | Subject: %s", previewLabel, p.To, subject)})
}

func (m *Mailer) frontendURL() string {
	if m.cfg.FrontendURL != "" {
		return m.cfg.FrontendURL
	}
	return "http://localhost:5173"
}

func orEN(locale string) string {
	if locale == "" {
		return "en"
	}
	return locale
}

func sessionText(s Strings, date, startTime, discipline string) string {
	t := s.DateLabel + " " + date + "\n" + s.TimeLabel + " " + startTime + "\n"
	if discipline != "" {
		t += s.DisciplineLabel + " " + discipline + "\n"
	}
	return t
}

// FormatDate renders a YYYY-MM-DD date like toLocaleDateString(en-GB | nl-NL,
// {weekday, year, month: 'long', day}) does in Node.
func FormatDate(date, locale string) string {
	d, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return "Invalid Date"
	}
	if locale == "nl" {
		return fmt.Sprintf("%s %d %s %d", nlWeekdays[d.Weekday()], d.Day(), nlMonths[d.Month()-1], d.Year())
	}
	return fmt.Sprintf("%s, %d %s %d", enWeekdays[d.Weekday()], d.Day(), enMonths[d.Month()-1], d.Year())
}

// escape matches email.ts escapeHtml (&, <, >, "; not ').
func escape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

var tags = regexp.MustCompile(`<[^>]*>`)

func stripHTML(s string) string { return tags.ReplaceAllString(s, "") }
