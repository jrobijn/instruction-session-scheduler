package db

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openTemp(t *testing.T) (*DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d, path
}

func latestVersion(t *testing.T) int64 {
	t.Helper()
	files, err := fs.Glob(migrations(), "*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations embedded: %v", err)
	}
	return int64(len(files))
}

func dbVersion(t *testing.T, d *DB) int64 {
	t.Helper()
	var v int64
	if err := d.QueryRow("SELECT MAX(version_id) FROM goose_db_version WHERE is_applied = 1").Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// legacySchema is the schema as the pre-goose Go server created it: 00001_init without goose.
func legacySchema(t *testing.T) string {
	t.Helper()
	b, err := fs.ReadFile(migrations(), "00001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMigrateFreshDatabase(t *testing.T) {
	d, path := openTemp(t)
	ctx := context.Background()
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if got, want := dbVersion(t, d), latestVersion(t); got != want {
		t.Fatalf("version = %d, want %d", got, want)
	}
	if got := Setting(d, "club_name", ""); got != "Sports Club" {
		t.Fatalf("club_name = %q, want seeded default", got)
	}
	if backups, _ := filepath.Glob(path + ".bak-*"); len(backups) != 0 {
		t.Fatalf("empty database should not be backed up, got %v", backups)
	}
	// A second run has nothing to do.
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestMigratePreGooseDatabase(t *testing.T) {
	d, path := openTemp(t)
	if _, err := d.Exec(legacySchema(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec("INSERT INTO students (first_name, last_name, email) VALUES ('A', 'B', 'a@example.com')"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec("UPDATE settings SET value = 'My Club' WHERE key = 'club_name'"); err != nil {
		t.Fatal(err)
	}

	if err := d.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got, want := dbVersion(t, d), latestVersion(t); got != want {
		t.Fatalf("version = %d, want %d", got, want)
	}
	var n int
	if err := d.QueryRow("SELECT COUNT(*) FROM students").Scan(&n); err != nil || n != 1 {
		t.Fatalf("students = %d (%v), want 1", n, err)
	}
	if got := Setting(d, "club_name", ""); got != "My Club" {
		t.Fatalf("club_name = %q, existing setting was overwritten", got)
	}
	if _, err := os.Stat(path + ".bak-v0"); err != nil {
		t.Fatalf("expected backup before migrating: %v", err)
	}
}

func TestMigrateRefusesOutdatedDatabase(t *testing.T) {
	d, _ := openTemp(t)
	if _, err := d.Exec("CREATE TABLE students (id INTEGER PRIMARY KEY, first_name TEXT)"); err != nil {
		t.Fatal(err)
	}
	err := d.Migrate(context.Background())
	if err == nil || !strings.Contains(err.Error(), "outdated") {
		t.Fatalf("err = %v, want schema outdated error", err)
	}
}

func TestMigrateRefusesNewerDatabase(t *testing.T) {
	d, _ := openTemp(t)
	ctx := context.Background()
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec("INSERT INTO goose_db_version (version_id, is_applied) VALUES (?, 1)", latestVersion(t)+1); err != nil {
		t.Fatal(err)
	}
	err := d.Migrate(ctx)
	if err == nil || !strings.Contains(err.Error(), "newer version") {
		t.Fatalf("err = %v, want newer-version error", err)
	}
}
