package server

import (
	"log"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// accessLog logs one line per API request: client IP, route, path values, status and
// duration. It logs the route pattern rather than the path, with the path values next to it
// except {token}: invitation and public discipline tokens are secret. Query strings are left
// out for the same reason. SSE streams are logged when they open, as they can stay open for
// hours. Static files and health checks are not logged.
func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api/health" {
			next.ServeHTTP(w, r)
			return
		}

		lw := &logWriter{ResponseWriter: w, r: r, start: time.Now()}

		// net/http recovers handler panics and logs their stack trace, but the request
		// would get no access line; log one, then let net/http handle the panic.
		defer func() {
			if p := recover(); p != nil {
				lw.log("panic", "")
				panic(p)
			}
		}()

		next.ServeHTTP(lw, r)
		if !lw.stream {
			if lw.code == 0 {
				lw.code = http.StatusOK // nothing written
			}

			lw.log(strconv.Itoa(lw.code), "")
		}
	})
}

// logWriter records the response status for accessLog.
type logWriter struct {
	http.ResponseWriter
	r      *http.Request
	start  time.Time
	code   int
	stream bool
}

func (w *logWriter) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
		if strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream") {
			w.stream = true
			w.log(strconv.Itoa(code), " stream opened")
		}
	}

	w.ResponseWriter.WriteHeader(code)
}

func (w *logWriter) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.WriteHeader(http.StatusOK)
	}

	return w.ResponseWriter.Write(b)
}

// Flush passes flushes through for the SSE hub, which asserts http.Flusher on the writer.
func (w *logWriter) Flush() {
	if w.code == 0 {
		w.WriteHeader(http.StatusOK)
	}

	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *logWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// wildcard matches a wildcard in a route pattern: {id}, or {rest...}.
var wildcard = regexp.MustCompile(`\{([A-Za-z0-9_]+)(?:\.\.\.)?\}`)

// plainValue matches path values that are safe to log unquoted.
var plainValue = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

// log writes the access line. The mux sets r.Pattern on the request in place, so it is
// known once the handler has been called. Under /api/ the "/" fallback means no API route
// matched.
func (w *logWriter) log(status, suffix string) {
	route := w.r.Pattern
	if route == "" || route == "/" {
		route = w.r.Method + " (no route)"
	}

	// Path values come from the client: anything but a short plain value is quoted, so it
	// can't break the line or forge another one.
	for _, m := range wildcard.FindAllStringSubmatch(w.r.Pattern, -1) {
		name := m[1]
		if name == "token" {
			continue
		}

		v := w.r.PathValue(name)
		if !plainValue.MatchString(v) {
			v = strconv.Quote(v[:min(len(v), 64)])
		}

		route += " " + name + "=" + v
	}

	// No reverse proxy sits in front of the server, so RemoteAddr is the client; forwarding
	// headers come from the client and could be forged.
	ip, _, err := net.SplitHostPort(w.r.RemoteAddr)
	if err != nil {
		ip = w.r.RemoteAddr
	}

	log.Printf("api: %s %s %s %s%s", ip, route, status, time.Since(w.start).Round(time.Microsecond), suffix)
}
