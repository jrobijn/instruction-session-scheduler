# Port 3000, database at /data/data.db, frontend served from the same origin.
#
#   docker build -t session-scheduler .

# Stage 1: Build frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
ENV VITE_API_BASE=/api
RUN npm run build

# Stage 2: Build the Go backend (pure Go SQLite driver, so no cgo toolchain is needed)
FROM golang:1.26-alpine AS backend-build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server .

# Stage 3: Production image
FROM alpine:3.22
# CA certificates for SMTP over TLS; time zone data is embedded in the binary.
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=backend-build /out/server ./server
COPY --from=frontend-build /app/frontend/dist ./public

ENV APP_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/data.db
ENV PUBLIC_DIR=/app/public

VOLUME /data
EXPOSE 3000

CMD ["./server"]
