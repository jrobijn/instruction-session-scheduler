package db

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/jmoiron/sqlx"
)

func openWithTable(t *testing.T) *DB {
	t.Helper()
	d, _ := openTemp(t)
	if _, err := d.Exec("CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB, parent INTEGER REFERENCES things(id))"); err != nil {
		t.Fatal(err)
	}
	return d
}

type thing struct {
	ID   int64   `db:"id"`
	Name *string `db:"name"`
	Rank int     `db:"-"` // not a column
}

func TestMany(t *testing.T) {
	d := openWithTable(t)
	d.Exec("INSERT INTO things (id, name) VALUES (1, 'a'), (2, NULL)")
	// Columns are matched by name, in any order.
	rows, err := Many[thing](d, "SELECT name, id FROM things ORDER BY id")
	if err != nil || len(rows) != 2 || rows[0].ID != 1 || *rows[0].Name != "a" || rows[1].Name != nil {
		t.Fatalf("Many = %+v, %v", rows, err)
	}
	empty, err := Many[thing](d, "SELECT id, name FROM things WHERE id = 99")
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty result = %#v, %v; want a non-nil empty slice (JSON [])", empty, err)
	}
	ids, err := Many[int64](d, "SELECT id FROM things ORDER BY id")
	if err != nil || len(ids) != 2 || ids[1] != 2 {
		t.Fatalf("Many[int64] = %v, %v", ids, err)
	}
	if _, err := Many[thing](d, "SELECT * FROM missing"); err == nil {
		t.Fatal("query error not returned")
	}
	if _, err := Many[thing](d, "SELECT id, name, score FROM things"); err == nil {
		t.Fatal("column without a struct field not reported")
	}
}

func TestOne(t *testing.T) {
	d := openWithTable(t)
	d.Exec("INSERT INTO things (id, name) VALUES (1, 'a'), (2, 'b')")
	th, found, err := One[thing](d, "SELECT id, name FROM things ORDER BY id")
	if err != nil || !found || th.ID != 1 {
		t.Fatalf("One = %+v, %v, %v", th, found, err)
	}
	_, found, err = One[thing](d, "SELECT id, name FROM things WHERE id = 3")
	if err != nil || found {
		t.Fatalf("One without rows: found %v, err %v", found, err)
	}
	if _, found, err := One[thing](d, "SELECT nope"); err == nil || found {
		t.Fatalf("query error: found %v, err %v", found, err)
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

	if err := d.InTx(func(tx *sqlx.Tx) error {
		_, err := tx.Exec("INSERT INTO things (id) VALUES (1)")
		return err
	}); err != nil || count() != 1 {
		t.Fatalf("commit: err %v, count %d", err, count())
	}

	boom := errors.New("boom")
	if err := d.InTx(func(tx *sqlx.Tx) error {
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
		d.InTx(func(tx *sqlx.Tx) error {
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
