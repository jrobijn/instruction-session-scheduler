package server

import (
	"net/http"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

func (s *Server) settingsRoutes() {
	s.adminRoute("GET /api/settings", func(w http.ResponseWriter, r *http.Request) error {
		rows, err := s.db.Query("SELECT key, value FROM settings")
		if err != nil {
			return err
		}
		defer rows.Close()
		settings := map[string]string{}
		for rows.Next() {
			var k, v string
			if err := rows.Scan(&k, &v); err != nil {
				return err
			}
			settings[k] = v
		}
		if err := rows.Err(); err != nil {
			return err
		}
		httpx.OK(w, settings)
		return nil
	})

	s.adminRoute("PUT /api/settings/{key}", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		raw, present := b["value"]
		if !present {
			httpx.Error(w, http.StatusBadRequest, "Value is required")
			return nil
		}
		key, value := r.PathValue("key"), jsString(raw)
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
