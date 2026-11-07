package db

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func openWithTable(t *testing.T) *DB {
	t.Helper()
	d, _ := openTemp(t)
	if _, err := d.Exec("CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB, parent INTEGER REFERENCES things(id))"); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestAllReturnsColumnMaps(t *testing.T) {
	d := openWithTable(t)
	if _, err := d.Exec("INSERT INTO things (id, name, score, data) VALUES (1, 'a', 1.5, x'6869'), (2, NULL, NULL, NULL)"); err != nil {
		t.Fatal(err)
	}
	rows, err := All(d, "SELECT id, name, score, data FROM things ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %v", rows)
	}
	first := rows[0]
	if first["id"] != int64(1) || first["name"] != "a" || first["score"] != 1.5 || first["data"] != "hi" {
		t.Fatalf("first row = %#v (blobs should become strings)", first)
	}
	for _, c := range []string{"name", "score", "data"} {
		if rows[1][c] != nil {
			t.Errorf("NULL %s = %#v", c, rows[1][c])
		}
	}

	empty, err := All(d, "SELECT * FROM things WHERE id = ?", 99)
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty result = %#v, %v; want a non-nil empty slice (JSON [])", empty, err)
	}
	if _, err := All(d, "SELECT * FROM missing"); err == nil {
		t.Fatal("query error not returned")
	}
}

func TestGet(t *testing.T) {
	d := openWithTable(t)
	d.Exec("INSERT INTO things (id, name) VALUES (1, 'a'), (2, 'b')")
	row, err := Get(d, "SELECT name FROM things ORDER BY id")
	if err != nil || row["name"] != "a" {
		t.Fatalf("Get = %v, %v", row, err)
	}
	row, err = Get(d, "SELECT name FROM things WHERE id = 3")
	if err != nil || row != nil {
		t.Fatalf("Get without rows = %v, %v", row, err)
	}
	if _, err := Get(d, "SELECT nope"); err == nil {
		t.Fatal("query error not returned")
	}
}

func TestSettingFallsBack(t *testing.T) {
	d, _ := openTemp(t)
	if got := Setting(d, "x", "def"); got != "def" { // no settings table at all
		t.Fatalf("got %q", got)
	}
	d.Exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
	d.Exec("INSERT INTO settings VALUES ('set', 'v'), ('empty', '')")
	for key, want := range map[string]string{"set": "v", "empty": "def", "missing": "def"} {
		if got := Setting(d, key, "def"); got != want {
			t.Errorf("Setting(%s) = %q, want %q", key, got, want)
		}
	}
}

func TestInTx(t *testing.T) {
	d := openWithTable(t)
	count := func() int {
		var n int
		d.QueryRow("SELECT COUNT(*) FROM things").Scan(&n)
		return n
	}

	if err := d.InTx(func(tx *sql.Tx) error {
		_, err := tx.Exec("INSERT INTO things (id) VALUES (1)")
		return err
	}); err != nil || count() != 1 {
		t.Fatalf("commit: err %v, count %d", err, count())
	}

	boom := errors.New("boom")
	if err := d.InTx(func(tx *sql.Tx) error {
		tx.Exec("INSERT INTO things (id) VALUES (2)")
		return boom
	}); !errors.Is(err, boom) || count() != 1 {
		t.Fatalf("rollback on error: err %v, count %d", err, count())
	}

	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("panic not re-raised")
			}
		}()
		d.InTx(func(tx *sql.Tx) error {
			tx.Exec("INSERT INTO things (id) VALUES (3)")
			panic("oops")
		})
	}()
	if count() != 1 {
		t.Fatalf("panic did not roll back: count %d", count())
	}
	// The single connection is usable again after each of these.
	if _, err := d.Exec("INSERT INTO things (id) VALUES (4)"); err != nil {
		t.Fatal(err)
	}
}

func TestOpenEnforcesForeignKeys(t *testing.T) {
	d := openWithTable(t)
	if _, err := d.Exec("INSERT INTO things (id, parent) VALUES (1, 42)"); err == nil {
		t.Fatal("foreign keys are not enforced")
	}
	var mode string
	d.QueryRow("PRAGMA journal_mode").Scan(&mode)
	if mode != "wal" {
		t.Errorf("journal_mode = %s, want wal", mode)
	}
}

func TestOpenFailsForUnreachablePath(t *testing.T) {
	if d, err := Open(filepath.Join(t.TempDir(), "missing-dir", "x.db")); err == nil {
		d.Close()
		t.Fatal("Open succeeded in a directory that does not exist")
	}
}
