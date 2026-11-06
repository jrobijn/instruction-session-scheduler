// Command backend is the HTTP server of the instruction session scheduler.
package main

import (
	"context"
	"errors"
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
	smtpCheck := flag.Bool("smtp-check", false, "connect to the SMTP server, report TLS details and test the login, then exit (sends no email)")
	migrateOnly := flag.Bool("migrate", false, "apply pending database migrations, then exit (the server also applies them on startup)")
	flag.Parse()
	cfg := config.Load()
	if *smtpCheck {
		mailer := email.New(email.Config{
			Host: cfg.SMTPHost, Port: cfg.SMTPPort, User: cfg.SMTPUser, Pass: cfg.SMTPPass,
			Secure: cfg.SMTPSecure,
		})
		if err := mailer.Check(os.Stdout); err != nil {
			fmt.Println("FAILED:", err)
			os.Exit(1)
		}
		return
	}

	database, err := db.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("open database %s: %v", cfg.DBPath, err)
	}
	defer database.Close()
	if err := database.Migrate(context.Background()); err != nil {
		log.Fatalf("migrate database %s: %v", cfg.DBPath, err)
	}
	if *migrateOnly {
		log.Printf("database %s is up to date", cfg.DBPath)
		return
	}

	mailer := email.New(email.Config{
		Host: cfg.SMTPHost, Port: cfg.SMTPPort, User: cfg.SMTPUser, Pass: cfg.SMTPPass, From: cfg.SMTPFrom,
		Secure: cfg.SMTPSecure, FrontendURL: cfg.FrontendURL, PreviewDir: cfg.EmailPreviewDir,
	})
	app := server.New(cfg, database, sse.NewHub(), mailer)
	app.Start()
	defer app.Stop()

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("Server running on http://localhost:%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}
