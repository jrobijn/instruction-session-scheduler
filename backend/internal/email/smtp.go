package email

import (
	"crypto/tls"
	"net"
	"net/smtp"
	"time"
)

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
