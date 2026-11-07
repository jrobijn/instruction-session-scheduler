package email

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/smtp"
	"time"
)

// tlsConfig uses Go's default TLS settings (TLS 1.2 and newer, Go's default cipher suites);
// the club's mail server negotiates TLS 1.2 with ECDHE and AES-GCM. The TS backend's
// SMTP_TLS_CIPHERS is not supported. Run the binary with -smtp-check to see what the
// server negotiates.
func (m *Mailer) tlsConfig() *tls.Config {
	return &tls.Config{ServerName: m.cfg.Host, RootCAs: m.rootCAs}
}

// connect dials the server and upgrades to TLS: implicit with SMTP_SECURE, otherwise
// STARTTLS when offered. Without TLS, authenticate refuses to send the credentials.
func (m *Mailer) connect(tlsConfig *tls.Config) (*smtp.Client, error) {
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

// Check connects to the configured server, reports the TLS parameters and tries to log
// in, without sending any email. It is the -smtp-check command.
func (m *Mailer) Check(out io.Writer) error {
	if m.cfg.Host == "" {
		return errors.New("SMTP_HOST is not set")
	}
	cfg := m.tlsConfig()
	fmt.Fprintf(out, "Server:      %s:%s (%s)\n", m.cfg.Host, m.cfg.Port, map[bool]string{true: "implicit TLS", false: "STARTTLS when offered"}[m.cfg.Secure])

	c, err := m.connect(cfg)
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		fmt.Fprintf(out, "Certificate: NOT TRUSTED: %v\n", certErr.Err)
		fmt.Fprintln(out, "             retrying without verification to show what the server negotiates…")
		insecure := cfg.Clone()
		insecure.InsecureSkipVerify = true
		c, err = m.connect(insecure)
	}
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer c.Close()

	if state, ok := c.TLSConnectionState(); ok {
		fmt.Fprintf(out, "Negotiated:  %s, %s\n", tls.VersionName(state.Version), tls.CipherSuiteName(state.CipherSuite))
		for i, cert := range state.PeerCertificates {
			fmt.Fprintf(out, "Cert %d:      %s (issuer %s), %s, %s key, expires %s\n", i, cert.Subject.CommonName,
				cert.Issuer.CommonName, cert.SignatureAlgorithm, keyDescription(cert), cert.NotAfter.Format(time.DateOnly))
		}
		if certErr == nil {
			fmt.Fprintln(out, "Certificate: trusted")
		}
	} else {
		fmt.Fprintln(out, "Negotiated:  no TLS (server does not offer STARTTLS)")
	}

	_, mechs := c.Extension("AUTH")
	fmt.Fprintf(out, "AUTH:        %s\n", mechs)
	if certErr != nil {
		return errors.New("not logging in over an untrusted connection; fix the certificate problem first")
	}
	if err := m.authenticate(c); err != nil {
		return fmt.Errorf("login failed: %w", err)
	}
	fmt.Fprintln(out, "Login:       OK (no email was sent)")
	return c.Quit()
}

func keyDescription(cert *x509.Certificate) string {
	switch k := cert.PublicKey.(type) {
	case interface{ Size() int }: // *rsa.PublicKey
		return fmt.Sprintf("%s %d-bit", cert.PublicKeyAlgorithm, k.Size()*8)
	default:
		return cert.PublicKeyAlgorithm.String()
	}
}
