package server

import (
	"net/http"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

func clubName(q db.Querier) string    { return db.Setting(q, "club_name", "Sports Club") }
func emailLocale(q db.Querier) string { return db.Setting(q, "email_locale", "en") }
func clubDays(q db.Querier) string    { return db.Setting(q, "club_days", "0|1|2|3|4|5|6") }

func (s *Server) settingsRoutes() {
	s.adminRoute("GET /api/settings", func(w http.ResponseWriter, r *http.Request) error {
		type setting struct {
			Key   string `db:"key"`
			Value string `db:"value"`
		}

		entries, err := db.Many[setting](s.db, "SELECT key, value FROM settings")
		if err != nil {
			return err
		}

		settings := make(map[string]string, len(entries))
		for _, st := range entries {
			settings[st.Key] = st.Value
		}

		httpx.OK(w, settings)
		return nil
	})

	s.adminRoute("PUT /api/settings/{key}", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Value *string `json:"value"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		if in.Value == nil {
			httpx.Error(w, http.StatusBadRequest, "Value is required")
			return nil
		}

		key, value := r.PathValue("key"), *in.Value
		if key == "timezone" {
			if _, err := time.LoadLocation(value); err != nil {
				httpx.Error(w, http.StatusBadRequest, "Invalid time zone")
				return nil
			}
		}

		if _, err := s.db.Exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, value); err != nil {
			return err
		}

		if (key == "invitation_expiry_minutes" || key == "timezone") && s.onExpirySettingsChanged != nil {
			s.onExpirySettingsChanged()
		}

		httpx.OK(w, map[string]string{"key": key, "value": value})
		return nil
	})
}
