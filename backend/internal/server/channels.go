package server

import "strconv"

// SSE channel names. Both the Serve routes and the broadcasters use these, so subscribers
// and publishers cannot drift apart.
const (
	sessionsListChannel  = "sessions-list"
	notificationsChannel = "notifications"
)

func sessionChannel(sessionID int64) string {
	return "session:" + strconv.FormatInt(sessionID, 10)
}

func invitationChannel(token string) string {
	return "invitation:" + token
}
