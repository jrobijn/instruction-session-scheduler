// Package auth implements the minimal HS256 JWT handling the admin login needs.
// Tokens are interchangeable with those issued by the TypeScript backend (jsonwebtoken).
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var (
	ErrMalformed = errors.New("malformed token")
	ErrSignature = errors.New("invalid signature")
	ErrExpired   = errors.New("token expired")
)

var b64 = base64.RawURLEncoding

const header = `{"alg":"HS256","typ":"JWT"}`

type Claims struct {
	Role string `json:"role"`
	Iat  int64  `json:"iat"`
	Exp  int64  `json:"exp"`
}

func Sign(secret, role string, ttl time.Duration) (string, error) {
	now := time.Now()
	payload, err := json.Marshal(Claims{Role: role, Iat: now.Unix(), Exp: now.Add(ttl).Unix()})
	if err != nil {
		return "", err
	}
	signingInput := b64.EncodeToString([]byte(header)) + "." + b64.EncodeToString(payload)
	return signingInput + "." + b64.EncodeToString(mac(secret, signingInput)), nil
}

func Verify(secret, token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrMalformed
	}

	var hdr struct {
		Alg string `json:"alg"`
	}
	rawHeader, err := b64.DecodeString(parts[0])
	if err != nil || json.Unmarshal(rawHeader, &hdr) != nil {
		return nil, ErrMalformed
	}
	if hdr.Alg != "HS256" {
		return nil, ErrMalformed
	}

	sig, err := b64.DecodeString(parts[2])
	if err != nil {
		return nil, ErrMalformed
	}
	if !hmac.Equal(sig, mac(secret, parts[0]+"."+parts[1])) {
		return nil, ErrSignature
	}

	rawPayload, err := b64.DecodeString(parts[1])
	if err != nil {
		return nil, ErrMalformed
	}
	var claims Claims
	if err := json.Unmarshal(rawPayload, &claims); err != nil {
		return nil, ErrMalformed
	}
	if claims.Exp != 0 && time.Now().Unix() >= claims.Exp {
		return nil, ErrExpired
	}
	return &claims, nil
}

func mac(secret, input string) []byte {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(input))
	return h.Sum(nil)
}
