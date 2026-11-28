package db

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
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

func TestMigrateBacksUpDatabaseWithData(t *testing.T) {
	d, path := openTemp(t)
	ctx := context.Background()
	provider, err := goose.NewProvider(goose.DialectSQLite3, d.DB.DB, migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec("INSERT INTO students (first_name, last_name, email) VALUES ('A', 'B', 'a@example.com')"); err != nil {
		t.Fatal(err)
	}

	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if got, want := dbVersion(t, d), latestVersion(t); got != want {
		t.Fatalf("version = %d, want %d", got, want)
	}
	if _, err := os.Stat(path + ".bak-v1"); err != nil {
		t.Fatalf("expected backup before migrating: %v", err)
	}
}

func TestMigrateRefusesPreGooseDatabase(t *testing.T) {
	d, path := openTemp(t)
	if _, err := d.Exec("CREATE TABLE students (id INTEGER PRIMARY KEY, first_name TEXT)"); err != nil {
		t.Fatal(err)
	}

	err := d.Migrate(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no migration history") {
		t.Fatalf("err = %v, want no-migration-history error", err)
	}
	if backups, _ := filepath.Glob(path + ".bak-*"); len(backups) != 0 {
		t.Fatalf("refused database should not be backed up, got %v", backups)
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

func TestMigrateMovesInviteNextToStudents(t *testing.T) {
	d, _ := openTemp(t)
	ctx := context.Background()
	provider, err := goose.NewProvider(goose.DialectSQLite3, d.DB.DB, migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 2); err != nil {
		t.Fatal(err)
	}

	for _, q := range []string{
		"INSERT INTO groups (id, name) VALUES (1, 'G')",
		"INSERT INTO students (id, first_name, last_name, email) VALUES (1, 'A', 'X', 'a@example.com'), (2, 'B', 'X', 'b@example.com')",
		"INSERT INTO student_groups (student_id, group_id, invite_next_at) VALUES (1, 1, '2026-01-01 00:00:00'), (2, 1, NULL)",
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := provider.UpTo(ctx, 3); err != nil {
		t.Fatal(err)
	}

	var a, b *string
	if err := d.QueryRow("SELECT (SELECT invite_next_at FROM students WHERE id = 1), (SELECT invite_next_at FROM students WHERE id = 2)").Scan(&a, &b); err != nil {
		t.Fatal(err)
	}
	if a == nil || *a != "2026-01-01 00:00:00" || b != nil {
		t.Fatalf("students.invite_next_at = %v, %v; want the membership's override copied, NULL kept", a, b)
	}

	// Down puts it back on the membership.
	if _, err := provider.DownTo(ctx, 2); err != nil {
		t.Fatal(err)
	}

	if err := d.QueryRow("SELECT invite_next_at FROM student_groups WHERE student_id = 1").Scan(&a); err != nil || a == nil || *a != "2026-01-01 00:00:00" {
		t.Fatalf("after down, student_groups.invite_next_at = %v (%v)", a, err)
	}
}
