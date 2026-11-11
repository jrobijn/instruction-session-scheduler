package email

import (
	"bufio"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"fmt"
	"math/big"
	"net"
	"net/mail"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeServer is a minimal SMTP server: STARTTLS with the given TLS configuration, then
// AUTH PLAIN, like the club's mail server.
type fakeServer struct {
	ln   net.Listener
	tls  *tls.Config
	mu   sync.Mutex
	user string
	pass string
	data string
	// active and maxActive count simultaneous connections; messages counts deliveries.
	active, maxActive, messages int
	dataDelay                   time.Duration
}

func newFakeServer(t *testing.T, cfg *tls.Config) *fakeServer {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeServer{ln: ln, tls: cfg}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	return s
}

func (s *fakeServer) serve(conn net.Conn) {
	s.mu.Lock()
	s.active++
	s.maxActive = max(s.maxActive, s.active)
	s.mu.Unlock()
	open := true
	closeConn := func() {
		s.mu.Lock()
		if open {
			s.active--
			open = false
		}
		s.mu.Unlock()
	}
	defer closeConn()
	defer conn.Close()
	r, w := bufio.NewReader(conn), conn
	say := func(line string) { w.Write([]byte(line + "\r\n")) }
	say("220 fake.test ESMTP")
	tlsOn := false
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.TrimSpace(line)
		upper := strings.ToUpper(cmd)
		switch {
		case strings.HasPrefix(upper, "EHLO"):
			if tlsOn {
				say("250-fake.test\r\n250 AUTH CRAM-MD5 PLAIN LOGIN")
			} else {
				say("250-fake.test\r\n250 STARTTLS")
			}
		case upper == "STARTTLS":
			say("220 go ahead")
			tc := tls.Server(conn, s.tls)
			if err := tc.Handshake(); err != nil {
				return
			}
			conn, tlsOn = tc, true
			r, w = bufio.NewReader(tc), tc
		case strings.HasPrefix(upper, "AUTH PLAIN "):
			raw, _ := base64.StdEncoding.DecodeString(cmd[len("AUTH PLAIN "):])
			parts := strings.Split(string(raw), "\x00")
			if len(parts) == 3 {
				s.mu.Lock()
				s.user, s.pass = parts[1], parts[2]
				s.mu.Unlock()
			}
			say("235 ok")
		case strings.HasPrefix(upper, "MAIL"), strings.HasPrefix(upper, "RCPT"):
			say("250 ok")
		case upper == "DATA":
			say("354 go")
			var b strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil || l == ".\r\n" {
					break
				}
				b.WriteString(l)
			}
			time.Sleep(s.dataDelay)
			s.mu.Lock()
			s.data = b.String()
			s.messages++
			s.mu.Unlock()
			say("250 queued")
		case upper == "QUIT":
			closeConn() // before replying, so the client's next connection never overlaps
			say("221 bye")
			return
		default:
			say("502 unknown")
		}
	}
}

func testCert(t *testing.T) (tls.Certificate, *x509.CertPool) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "127.0.0.1"},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:   time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pool
}

// clubLikeServer negotiates what the club's server does: TLS 1.2 (no 1.3) with ECDHE.
func clubLikeServer(t *testing.T) (*fakeServer, *x509.CertPool) {
	cert, roots := testCert(t)
	return newFakeServer(t, &tls.Config{
		Certificates: []tls.Certificate{cert},
		MaxVersion:   tls.VersionTLS12,
		CipherSuites: []uint16{tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384},
	}), roots
}

func mailerFor(s *fakeServer, roots *x509.CertPool) *Mailer {
	host, port, _ := net.SplitHostPort(s.ln.Addr().String())
	return &Mailer{enabled: true, rootCAs: roots, cfg: Config{
		Host: host, Port: port, User: "club@example.test", Pass: "s3cret", From: "club@example.test",
	}}
}

func TestSend(t *testing.T) {
	srv, roots := clubLikeServer(t)
	if err := mailerFor(srv, roots).send("student@example.test", "Uitnodiging", "text", "<p>html</p>"); err != nil {
		t.Fatalf("send: %v", err)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.user != "club@example.test" || srv.pass != "s3cret" {
		t.Errorf("AUTH PLAIN got %q / %q", srv.user, srv.pass)
	}
	if !strings.Contains(srv.data, "Subject: Uitnodiging") {
		t.Errorf("message not delivered: %q", srv.data)
	}
}

// Display names are quoted or RFC 2047-encoded in the headers.
func TestBuildMessageEncodesDisplayNames(t *testing.T) {
	from := &mail.Address{Name: "Schietclüb Zuid", Address: "club@example.test"}
	to := &mail.Address{Name: "John Q. Doe", Address: "student@example.test"}
	msg, err := buildMessage(from, to, "Uitnodiging", "text", "<p>html</p>")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"From: =?utf-8?q?Schietcl=C3=BCb_Zuid?= <club@example.test>\r\n",
		`To: "John Q. Doe" <student@example.test>` + "\r\n",
		"Message-ID: <",
	} {
		if !strings.Contains(string(msg), want) {
			t.Errorf("missing %q in:\n%s", want, msg)
		}
	}
	if !strings.Contains(string(msg), "@example.test>\r\nMIME-Version") {
		t.Errorf("Message-ID does not use the sender's domain:\n%s", msg)
	}
}

// An address carrying CR/LF must not reach the server, so it cannot inject headers.
func TestSendRejectsHeaderInjection(t *testing.T) {
	srv, roots := clubLikeServer(t)
	err := mailerFor(srv, roots).send("student@example.test\r\nBcc: victim@example.test", "Hi", "text", "<p>html</p>")
	if err == nil {
		t.Fatal("expected an invalid recipient error")
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.messages != 0 {
		t.Errorf("message was delivered: %q", srv.data)
	}
}

// A burst of emails (e.g. a batch of invitations) must use one connection at a time.
func TestSendOneAtATime(t *testing.T) {
	srv, roots := clubLikeServer(t)
	srv.dataDelay = 20 * time.Millisecond
	m := mailerFor(srv, roots)
	const n = 8
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			if err := m.send(fmt.Sprintf("s%d@example.test", i), "Uitnodiging", "t", "h"); err != nil {
				t.Errorf("send %d: %v", i, err)
			}
		})
	}
	wg.Wait()
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.messages != n {
		t.Fatalf("%d of %d emails delivered", srv.messages, n)
	}
	if srv.maxActive != 1 {
		t.Fatalf("%d simultaneous SMTP connections, want 1", srv.maxActive)
	}
}
