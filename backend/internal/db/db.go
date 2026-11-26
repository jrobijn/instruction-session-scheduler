// Package db opens the SQLite database and provides helpers that scan query results into
// typed values (Many, One).
//
// Rows are scanned into structs by column name (sqlx): each field that is read from the
// database has a `db:"column"` tag, and every selected column must have a matching field.
// Name computed columns with AS. Fields filled in by Go code are tagged `db:"-"`.
package db

import (
	"database/sql"
	"errors"
	"net/url"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

type DB struct {
	*sqlx.DB
	path string
}

// Querier is satisfied by both *DB and *sqlx.Tx.
type Querier interface {
	sqlx.Queryer
	sqlx.Execer
}

func Open(path string) (*DB, error) {
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")

	// modernc registers as "sqlite", which sqlx does not know uses ? placeholders.
	sqlx.BindDriver("sqlite", sqlx.QUESTION)
	sqlDB, err := sqlx.Open("sqlite", "file:"+path+"?"+q.Encode())
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

// Many runs a query and scans every row into a T: a struct (by column name, see the package
// comment) or a single-column value such as int64. It never returns a nil slice, so an empty
// result encodes as [] rather than null.
func Many[T any](q Querier, query string, args ...any) ([]T, error) {
	out := []T{}
	if err := sqlx.Select(q, &out, query, args...); err != nil {
		return nil, err
	}

	return out, nil
}

// One scans the first row of a query into a T, like Many. found is false (with a nil error)
// if there is no row.
func One[T any](q Querier, query string, args ...any) (v T, found bool, err error) {
	err = sqlx.Get(q, &v, query, args...)
	if errors.Is(err, sql.ErrNoRows) {
		return v, false, nil
	}

	return v, err == nil, err
}

// Get scans the first row of a query into a T, like One, but a missing row is an error
// (sql.ErrNoRows): for queries that must return a row, such as INSERT … RETURNING.
func Get[T any](q Querier, query string, args ...any) (v T, err error) {
	err = sqlx.Get(q, &v, query, args...)
	return v, err
}

// Setting reads a value from the settings table, falling back to def.
func Setting(q Querier, key, def string) string {
	var v string
	if err := q.QueryRowx("SELECT value FROM settings WHERE key = ?", key).Scan(&v); err != nil || v == "" {
		return def
	}

	return v
}

// InTx runs fn in a transaction, committing on success and rolling back on error or panic.
func (d *DB) InTx(fn func(tx *sqlx.Tx) error) (err error) {
	tx, err := d.Beginx()
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
