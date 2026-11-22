// Command backend is the HTTP server of the instruction session scheduler.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // club time zones must resolve even on minimal images

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/config"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/server"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/sse"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

// run holds the body of main so that its deferred cleanup still runs on failure, which
// log.Fatal in main would skip.
func run() error {
	migrateOnly := flag.Bool("migrate", false, "apply pending database migrations, then exit (the server also applies them on startup)")
	flag.Parse()
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	database, err := db.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open database %s: %w", cfg.DBPath, err)
	}
	defer database.Close()
	if err := database.Migrate(context.Background()); err != nil {
		return fmt.Errorf("migrate database %s: %w", cfg.DBPath, err)
	}
	if *migrateOnly {
		log.Printf("database %s is up to date", cfg.DBPath)
		return nil
	}

	mailer := email.New(email.Config{
		Host: cfg.SMTPHost, Port: cfg.SMTPPort, User: cfg.SMTPUser, Pass: cfg.SMTPPass, From: cfg.SMTPFrom,
		Secure: cfg.SMTPSecure, FrontendURL: cfg.FrontendURL, PreviewDir: cfg.EmailPreviewDir,
	})
	hub := sse.NewHub()
	app := server.New(cfg, database, hub, mailer)
	app.Start()
	defer app.Stop()

	// There is no reverse proxy in front of the server, so it sets its own timeouts. No
	// WriteTimeout: it would cut off the long-lived SSE streams.
	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	srv.RegisterOnShutdown(hub.Close)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	listenErr := make(chan error, 1)
	go func() {
		log.Printf("Server running on http://localhost:%s", cfg.Port)
		listenErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-listenErr:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
	}
	// Restore default signal handling so a second Ctrl+C kills a hanging shutdown.
	stop()
	log.Printf("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}
