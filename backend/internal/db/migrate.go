package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"os"
	"strings"
	"time"

	"github.com/pressly/goose/v3"
)

// Migrations live in migrations/ as goose SQL files named NNNNN_description.sql. Never edit
// one after it has been released: databases that already ran it will not run it again.
//
//go:embed migrations/*.sql
var embedded embed.FS

func migrations() fs.FS {
	sub, err := fs.Sub(embedded, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

// Migrate brings the database up to the newest embedded migration. Before applying anything
// to a database that already has data, it writes a backup next to it (<path>.bak-v<version>).
// It refuses to run on a database from before the last TypeScript release, and on one that a
// newer build of the server has migrated.
func (d *DB) Migrate(ctx context.Context) error {
	provider, err := goose.NewProvider(goose.DialectSQLite3, d.DB.DB, migrations())
	if err != nil {
		return err
	}

	current, target, err := provider.GetVersions(ctx)
	if err != nil {
		return err
	}
	if current > target {
		return fmt.Errorf("database is at migration %d but this build only knows up to %d: it was migrated by a newer version of the server", current, target)
	}
	if current == target {
		return nil
	}

	hasData, err := d.hasTable("students")
	if err != nil {
		return err
	}
	if hasData {
		if current == 0 {
			// Created before goose: 00001_init must find the final TypeScript schema, which its
			// IF NOT EXISTS statements then leave untouched.
			if err := d.checkUpToDate(); err != nil {
				return err
			}
		}
		if err := d.backup(current); err != nil {
			return err
		}
	}

	results, err := provider.Up(ctx)
	for _, r := range results {
		log.Printf("migration %s", r)
	}
	return err
}

func (d *DB) hasTable(name string) (bool, error) {
	var n int
	err := d.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", name).Scan(&n)
	return n > 0, err
}

// backup writes a consistent copy of the database with VACUUM INTO. In-memory databases
// have no path and are not backed up.
func (d *DB) backup(version int64) error {
	if d.path == "" || d.path == ":memory:" || strings.HasPrefix(d.path, "file::memory:") {
		return nil
	}
	dest := fmt.Sprintf("%s.bak-v%d", d.path, version)
	if _, err := os.Stat(dest); err == nil {
		dest = fmt.Sprintf("%s.bak-v%d-%s", d.path, version, time.Now().Format("20060102-150405"))
	}
	if _, err := d.Exec("VACUUM INTO ?", dest); err != nil {
		return fmt.Errorf("back up database before migrating: %w", err)
	}
	log.Printf("database backed up to %s", dest)
	return nil
}
