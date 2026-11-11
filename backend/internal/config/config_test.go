package config

import (
	"os"
	"path/filepath"
	"testing"
)

var configVars = []string{
	"PORT", "FRONTEND_URL", "ADMIN_PASSWORD", "JWT_SECRET", "DB_PATH", "PUBLIC_DIR", "NODE_ENV", "APP_ENV",
	"SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "EMAIL_PREVIEW_DIR",
}

// cleanEnv unsets every config variable for the test and runs it in an empty directory, so
// no .env file is picked up.
func cleanEnv(t *testing.T) string {
	t.Helper()
	for _, k := range configVars {
		t.Setenv(k, "") // registers restoration
		os.Unsetenv(k)
	}
	dir := t.TempDir()
	t.Chdir(dir)
	return dir
}

func TestLoadDefaults(t *testing.T) {
	cleanEnv(t)
	c := Load()
	want := Config{
		Port: "3001", FrontendURL: "http://localhost:5173", JWTSecret: "change-me",
		DBPath: "data.db", PublicDir: "public", SMTPPort: "587",
	}
	if c != want {
		t.Fatalf("defaults = %+v\nwant %+v", c, want)
	}
}

func TestLoadFromEnvironment(t *testing.T) {
	cleanEnv(t)
	t.Setenv("ADMIN_PASSWORD", "pw")
	t.Setenv("SMTP_SECURE", "true")
	t.Setenv("APP_ENV", "production")
	c := Load()
	if c.AdminPassword != "pw" || c.JWTSecret != "pw" || !c.SMTPSecure || !c.Production {
		t.Fatalf("config = %+v (JWT secret falls back to the admin password)", c)
	}
	t.Setenv("JWT_SECRET", "jwt")
	t.Setenv("SMTP_SECURE", "1")
	t.Setenv("APP_ENV", "")
	t.Setenv("NODE_ENV", "production")
	c = Load()
	if c.JWTSecret != "jwt" || c.SMTPSecure || !c.Production {
		t.Fatalf("config = %+v", c)
	}
}

func TestLoadDotEnv(t *testing.T) {
	dir := cleanEnv(t)
	t.Setenv("PORT", "9999") // already set: .env must not override it
	env := `# comment
export ADMIN_PASSWORD=secret
FRONTEND_URL="http://quoted.test"
SMTP_FROM='Club <club@example.test>'
SMTP_HOST=mail.example.test # trailing comment
PORT=1234
not a pair
EMPTY=
`
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	c := Load()
	for name, tc := range map[string]struct{ got, want string }{
		"admin password": {c.AdminPassword, "secret"},
		"double quotes":  {c.FrontendURL, "http://quoted.test"},
		"single quotes":  {c.SMTPFrom, "Club <club@example.test>"},
		"comment":        {c.SMTPHost, "mail.example.test"},
		"no override":    {c.Port, "9999"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q", name, tc.got, tc.want)
		}
	}
	if v, ok := os.LookupEnv("EMPTY"); !ok || v != "" {
		t.Errorf("EMPTY = %q, %v", v, ok)
	}
	os.Unsetenv("EMPTY")
}
