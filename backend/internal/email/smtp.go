package email

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strings"
	"time"
)

// send delivers one email over its own SMTP connection. Calls are serialized, so a burst
// of emails never opens parallel connections to the server.
func (m *Mailer) send(toRaw, subject, text, htmlBody string) error {
	fromRaw := m.cfg.From
	if fromRaw == "" {
		fromRaw = m.cfg.User
	}
	from, err := mail.ParseAddress(fromRaw)
	if err != nil {
		return fmt.Errorf("invalid sender address %q: %w", fromRaw, err)
	}
	to, err := mail.ParseAddress(toRaw)
	if err != nil {
		return fmt.Errorf("invalid recipient address %q: %w", toRaw, err)
	}
	msg, err := buildMessage(from, to, subject, text, htmlBody)
	if err != nil {
		return err
	}

	m.sending.Lock()
	defer m.sending.Unlock()
	c, err := m.connect()
	if err != nil {
		return err
	}
	defer c.Close()
	if err := m.authenticate(c); err != nil {
		return err
	}
	if err := c.Mail(from.Address); err != nil {
		return err
	}
	if err := c.Rcpt(to.Address); err != nil {
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

// buildMessage takes parsed addresses so the From and To headers are always well-formed:
// mail.Address.String() quotes or RFC 2047-encodes the display name as needed, and
// ParseAddress has already rejected anything with CR/LF that could inject headers.
func buildMessage(from, to *mail.Address, subject, text, htmlBody string) ([]byte, error) {
	var b strings.Builder
	mw := multipart.NewWriter(&b)
	id := make([]byte, 12)
	rand.Read(id)
	domain := "localhost"
	if at := strings.LastIndex(from.Address, "@"); at >= 0 {
		domain = from.Address[at+1:]
	}
	headers := []string{
		"From: " + from.String(),
		"To: " + to.String(),
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

// tlsConfig uses Go's default TLS settings (TLS 1.2 and newer, Go's default cipher suites);
// the club's mail server negotiates TLS 1.2 with ECDHE and AES-GCM. The TS backend's
// SMTP_TLS_CIPHERS is not supported. The backend README shows how to see what the
// server negotiates.
func (m *Mailer) tlsConfig() *tls.Config {
	return &tls.Config{ServerName: m.cfg.Host, RootCAs: m.rootCAs}
}

// connect dials the server and upgrades to TLS: implicit with SMTP_SECURE, otherwise
// STARTTLS when offered. Without TLS, authenticate refuses to send the credentials.
func (m *Mailer) connect() (*smtp.Client, error) {
	tlsConfig := m.tlsConfig()
	addr := net.JoinHostPort(m.cfg.Host, m.cfg.Port)
	dialer := &net.Dialer{Timeout: 30 * time.Second}
	var conn net.Conn
	var err error
	if m.cfg.Secure {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, tlsConfig)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(2 * time.Minute))
	c, err := smtp.NewClient(conn, m.cfg.Host)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if !m.cfg.Secure {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(tlsConfig); err != nil {
				c.Close()
				return nil, err
			}
		}
	}
	return c, nil
}

// authenticate logs in with AUTH PLAIN when the server asks for authentication.
// net/smtp's PlainAuth only sends credentials over TLS (or to localhost).
func (m *Mailer) authenticate(c *smtp.Client) error {
	if ok, _ := c.Extension("AUTH"); !ok || m.cfg.User == "" {
		return nil
	}
	return c.Auth(smtp.PlainAuth("", m.cfg.User, m.cfg.Pass, m.cfg.Host))
}
