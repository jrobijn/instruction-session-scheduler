package auth

import (
	"errors"
	"testing"
	"time"
)

func TestSignVerify(t *testing.T) {
	tok, err := Sign("secret", "admin", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := Verify("secret", tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.Role != "admin" {
		t.Fatalf("role = %q", claims.Role)
	}
	if _, err := Verify("other", tok); !errors.Is(err, ErrSignature) {
		t.Fatalf("wrong secret: got %v", err)
	}
}

func TestExpired(t *testing.T) {
	tok, _ := Sign("secret", "admin", -time.Second)
	if _, err := Verify("secret", tok); !errors.Is(err, ErrExpired) {
		t.Fatalf("got %v, want ErrExpired", err)
	}
}

// Token produced by jsonwebtoken: jwt.sign({ role: 'admin', iat: 1700000000, exp: 4102444800 }, 'secret')
func TestVerifyJsonwebtokenToken(t *testing.T) {
	const tok = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYWRtaW4iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6NDEwMjQ0NDgwMH0."
	sig := b64.EncodeToString(mac("secret", tok[:len(tok)-1]))
	if _, err := Verify("secret", tok+sig); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestMalformed(t *testing.T) {
	for _, tok := range []string{"", "a.b", "a.b.c", "eyJhbGciOiJub25lIn0.e30."} {
		if _, err := Verify("secret", tok); err == nil {
			t.Errorf("Verify(%q) succeeded", tok)
		}
	}
}
