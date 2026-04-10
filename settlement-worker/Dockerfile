FROM golang:1.21-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /settlement-worker ./cmd/worker

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app
COPY --from=builder /settlement-worker .

# Non-root user
RUN adduser -D -s /bin/sh worker
USER worker

ENTRYPOINT ["/app/settlement-worker"]
