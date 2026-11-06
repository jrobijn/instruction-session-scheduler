// Package config loads settings from the environment, optionally seeded from a .env file.
package config

import (
	"bufio"
	"os"
	"strings"
)

type Config struct {
	Port          string
	FrontendURL   string
	AdminPassword string
	JWTSecret     string
	DBPath        string
	PublicDir     string
	Production    bool

	SMTPHost   string
	SMTPPort   string
	SMTPSecure bool
	SMTPUser   string
	SMTPPass   string
	SMTPFrom   string
	// EmailPreviewDir: when SMTP is not configured, unsent emails are saved here as HTML.
	EmailPreviewDir string
}

// Load reads .env (if present) without overriding variables already set, then builds a Config.
func Load() Config {
	loadDotEnv(".env")

	adminPassword := os.Getenv("ADMIN_PASSWORD")
	jwtSecret := firstNonEmpty(os.Getenv("JWT_SECRET"), adminPassword, "change-me")

	return Config{
		Port:          firstNonEmpty(os.Getenv("PORT"), "3001"),
		FrontendURL:   firstNonEmpty(os.Getenv("FRONTEND_URL"), "http://localhost:5173"),
		AdminPassword: adminPassword,
		JWTSecret:     jwtSecret,
		DBPath:        firstNonEmpty(os.Getenv("DB_PATH"), "data.db"),
		PublicDir:     firstNonEmpty(os.Getenv("PUBLIC_DIR"), "public"),
		Production:    os.Getenv("NODE_ENV") == "production" || os.Getenv("APP_ENV") == "production",

		SMTPHost:   os.Getenv("SMTP_HOST"),
		SMTPPort:   firstNonEmpty(os.Getenv("SMTP_PORT"), "587"),
		SMTPSecure: os.Getenv("SMTP_SECURE") == "true",
		SMTPUser:   os.Getenv("SMTP_USER"),
		SMTPPass:   os.Getenv("SMTP_PASS"),
		SMTPFrom:   os.Getenv("SMTP_FROM"),

		EmailPreviewDir: os.Getenv("EMAIL_PREVIEW_DIR"),
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// loadDotEnv supports the subset of dotenv syntax used by .env.example:
// KEY=value lines, # comments, optional surrounding quotes.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		} else if i := strings.Index(value, " #"); i >= 0 {
			value = strings.TrimSpace(value[:i])
		}
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, value)
		}
	}
}
