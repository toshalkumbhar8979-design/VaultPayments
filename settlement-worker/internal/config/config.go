package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all configuration for the settlement worker.
type Config struct {
	// PostgreSQL
	PGHost     string
	PGPort     int
	PGDatabase string
	PGUser     string
	PGPassword string
	PGSSL      string

	// Redis
	RedisAddr     string
	RedisPassword string
	RedisDB       int

	// Settlement
	SettlementHour    int           // Hour of day to run (UTC), default 2 AM
	BatchSize         int           // Max payments per batch
	SettlementDelay   time.Duration // T+N delay (T+1 = 24h)
	PayoutMethod      string        // "IMPS", "NEFT"
	IMPSThreshold     int64         // Amount below which IMPS is used (in paise)

	// Bank API (Sponsor Bank)
	BankAPIBaseURL string
	BankAPIKey     string
	BankAPISecret  string
	SandboxMode    bool

	// Worker
	WorkerID       string
	TickerInterval time.Duration
}

// Load reads configuration from environment variables with sensible defaults.
func Load() *Config {
	return &Config{
		PGHost:     getEnv("PG_HOST", "localhost"),
		PGPort:     getEnvInt("PG_PORT", 5432),
		PGDatabase: getEnv("PG_DATABASE", "nexuspay_ledger"),
		PGUser:     getEnv("PG_USER", "nexuspay"),
		PGPassword: getEnv("PG_PASSWORD", "nexuspay_secure_2026"),
		PGSSL:      getEnv("PG_SSL", "disable"),

		RedisAddr:     getEnv("REDIS_ADDR", "localhost:6379"),
		RedisPassword: getEnv("REDIS_PASSWORD", ""),
		RedisDB:       getEnvInt("REDIS_DB", 0),

		SettlementHour:  getEnvInt("SETTLEMENT_HOUR", 2),
		BatchSize:       getEnvInt("SETTLEMENT_BATCH_SIZE", 500),
		SettlementDelay: time.Duration(getEnvInt("SETTLEMENT_DELAY_HOURS", 24)) * time.Hour,
		PayoutMethod:    getEnv("PAYOUT_METHOD", "NEFT"),
		IMPSThreshold:   int64(getEnvInt("IMPS_THRESHOLD", 20000000)), // ₹2,00,000 in paise

		BankAPIBaseURL: getEnv("BANK_API_BASE_URL", "https://sandbox.bank-api.example.com"),
		BankAPIKey:     getEnv("BANK_API_KEY", "sandbox-key"),
		BankAPISecret:  getEnv("BANK_API_SECRET", "sandbox-secret"),
		SandboxMode:    getEnv("BANK_SANDBOX_MODE", "true") == "true",

		WorkerID:       getEnv("WORKER_ID", "settlement-worker-1"),
		TickerInterval: time.Duration(getEnvInt("TICKER_INTERVAL_MINUTES", 60)) * time.Minute,
	}
}

// DSN returns the PostgreSQL connection string.
func (c *Config) DSN() string {
	return fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s",
		c.PGUser, c.PGPassword, c.PGHost, c.PGPort, c.PGDatabase, c.PGSSL,
	)
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return fallback
}
