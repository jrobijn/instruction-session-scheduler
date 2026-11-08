package server

import (
	"net/http"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

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
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.Value == nil {
			httpx.Error(w, http.StatusBadRequest, "Value is required")
			return nil
		}
		key, value := r.PathValue("key"), *in.Value
		if key == "timezone" && !isValidTimeZone(value) {
			httpx.Error(w, http.StatusBadRequest, "Invalid time zone")
			return nil
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
