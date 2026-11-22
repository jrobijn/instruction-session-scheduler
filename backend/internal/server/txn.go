package server

import (
	"time"

	"github.com/jmoiron/sqlx"
)

// txn is a unit of work for operations that call each other, such as expiring an invitation
// and inviting a replacement. Its methods run every query on q, so the operation commits or
// rolls back as a whole, and queue their emails, broadcasts, timers and notifications with
// afterCommit, so a rollback leaves no trace outside the database.
//
// txn deliberately has no *Server: inside a transaction, a query on s.db would deadlock (see
// db.Open). Side effects get the server once the transaction has committed.
type txn struct {
	q     *sqlx.Tx
	now   time.Time // the server clock when the transaction began
	after []func(s *Server)
}

// afterCommit queues f to run once the transaction has committed; it is dropped on rollback.
// f runs outside the transaction, so it may use s.db; it should log its errors, as the
// operation has already succeeded.
func (t *txn) afterCommit(f func(s *Server)) {
	t.after = append(t.after, f)
}

// inTx runs fn in a transaction and, once that has committed, the side effects fn queued.
func (s *Server) inTx(fn func(t *txn) error) error {
	t := &txn{now: s.now()}
	err := s.db.InTx(func(tx *sqlx.Tx) error {
		t.q = tx
		return fn(t)
	})
	if err != nil {
		return err
	}

	for _, f := range t.after {
		f(s)
	}

	return nil
}
