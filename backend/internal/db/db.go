// Package db opens the SQLite database and provides helpers that return rows in the same
// shape the former TypeScript backend's driver did (column name -> value), which the
// frontend expects in JSON responses.
package db

import (
	"database/sql"
	"fmt"
	"net/url"
	"strings"

	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
	path string
}

// Querier is satisfied by both *sql.DB and *sql.Tx.
type Querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

func Open(path string) (*DB, error) {
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")
	sqlDB, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	// A single connection serializes all statements, so read-modify-write handlers cannot
	// interleave mid-statement.
	// Never run a query on the *DB while holding a Tx from it, or it will deadlock.
	sqlDB.SetMaxOpenConns(1)
	if err := sqlDB.Ping(); err != nil {
		sqlDB.Close()
		return nil, err
	}
	return &DB{DB: sqlDB, path: path}, nil
}

// requiredColumns lists the most recently added columns per table; if any is missing, the
// database predates the last TypeScript migrations (removed after commit 75f9869). Only
// checked on databases created before goose, see Migrate.
var requiredColumns = map[string][]string{
	"students":         {"cooldown_until", "deleted_at", "membership_id"},
	"instructors":      {"deleted_at"},
	"invitations":      {"slot_id", "decision_log", "group_id"},
	"student_groups":   {"joined_at", "reactivated_at", "invite_next_at"},
	"groups":           {"new_member_priority", "reactivated_member_priority", "cooldown_member_priority"},
	"timetable_groups": {"position"},
	"notifications":    {"session_id"},
	"session_slots":    {"removed"},
}

func (d *DB) checkUpToDate() error {
	for table, cols := range requiredColumns {
		existing := map[string]bool{}
		rows, err := d.Query("SELECT name FROM pragma_table_info(?)", table)
		if err != nil {
			return err
		}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close()
				return err
			}
			existing[name] = true
		}
		rows.Close()
		for _, c := range cols {
			if !existing[c] {
				return fmt.Errorf("database schema is outdated (%s.%s missing): run the last TypeScript release (git commit 75f9869) on it once to migrate it", table, c)
			}
		}
	}
	var invSQL string
	if err := d.QueryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='invitations'").Scan(&invSQL); err != nil {
		return err
	}
	if !strings.Contains(invSQL, "'invalidated'") {
		return fmt.Errorf("database schema is outdated (invitations status constraint): run the last TypeScript release (git commit 75f9869) on it once to migrate it")
	}
	return nil
}

// All runs a query and returns every row as a column->value map.
func All(q Querier, query string, args ...any) ([]map[string]any, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			if b, ok := values[i].([]byte); ok {
				row[c] = string(b)
			} else {
				row[c] = values[i]
			}
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Get returns the first row, or nil if there is none (like better-sqlite3's .get() in the former TypeScript backend).
func Get(q Querier, query string, args ...any) (map[string]any, error) {
	rows, err := All(q, query, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// Setting reads a value from the settings table, falling back to def.
func Setting(q Querier, key, def string) string {
	var v string
	if err := q.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&v); err != nil || v == "" {
		return def
	}
	return v
}

// InTx runs fn in a transaction, committing on success and rolling back on error or panic.
func (d *DB) InTx(fn func(tx *sql.Tx) error) (err error) {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			tx.Rollback()
			panic(p)
		}
		if err != nil {
			tx.Rollback()
		} else {
			err = tx.Commit()
		}
	}()
	return fn(tx)
}
