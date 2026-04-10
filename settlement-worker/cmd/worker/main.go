package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"nexuspay-settlement-worker/internal/config"
	"nexuspay-settlement-worker/internal/settler"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("═══════════════════════════════════════════════")
	log.Println("  NexusPay Settlement Worker v1.0.0")
	log.Println("  High-concurrency daily payout processor")
	log.Println("═══════════════════════════════════════════════")

	// Load configuration
	cfg := config.Load()
	log.Printf("[CONFIG] Worker ID: %s", cfg.WorkerID)
	log.Printf("[CONFIG] Settlement hour: %d UTC", cfg.SettlementHour)
	log.Printf("[CONFIG] Payout method: %s (IMPS threshold: ₹%.2f)",
		cfg.PayoutMethod, float64(cfg.IMPSThreshold)/100)
	log.Printf("[CONFIG] Sandbox mode: %v", cfg.SandboxMode)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── Connect to PostgreSQL ───────────────────────────────────────────
	pgPool, err := pgxpool.New(ctx, cfg.DSN())
	if err != nil {
		log.Printf("[PG] Warning: PostgreSQL not available (%v). Running in dry-run mode.", err)
		pgPool = nil
	} else {
		defer pgPool.Close()
		log.Printf("[PG] Connected to %s:%d/%s", cfg.PGHost, cfg.PGPort, cfg.PGDatabase)
	}

	// ── Connect to Redis ────────────────────────────────────────────────
	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
	})

	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("[REDIS] Warning: Redis not available (%v). Using ticker-based scheduling.", err)
		rdb = nil
	} else {
		defer rdb.Close()
		log.Printf("[REDIS] Connected to %s", cfg.RedisAddr)
	}

	// ── Initialize Settler ──────────────────────────────────────────────
	var stl *settler.Settler
	if pgPool != nil {
		stl = settler.NewSettler(pgPool, cfg)
	}

	// ── Start Worker Loop ───────────────────────────────────────────────
	go func() {
		if rdb != nil {
			// Redis-triggered mode: listen for settlement jobs
			log.Println("[WORKER] Listening for Redis settlement jobs on 'nexuspay:settlement:trigger'")
			runRedisConsumer(ctx, rdb, stl, cfg)
		} else {
			// Ticker mode: run on schedule
			log.Printf("[WORKER] Running on %v ticker schedule", cfg.TickerInterval)
			runTickerMode(ctx, stl, cfg)
		}
	}()

	// ── Also run daily scheduler ────────────────────────────────────────
	go runDailyScheduler(ctx, stl, cfg)

	// ── Graceful Shutdown ───────────────────────────────────────────────
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigCh
	log.Printf("[WORKER] Received %s, shutting down gracefully...", sig)
	cancel()
	time.Sleep(2 * time.Second) // Allow in-flight operations to complete
	log.Println("[WORKER] Settlement worker stopped.")
}

// runRedisConsumer listens for settlement trigger messages from Redis.
func runRedisConsumer(ctx context.Context, rdb *redis.Client, stl *settler.Settler, cfg *config.Config) {
	pubsub := rdb.Subscribe(ctx, "nexuspay:settlement:trigger")
	defer pubsub.Close()

	ch := pubsub.Channel()

	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-ch:
			log.Printf("[REDIS] Received settlement trigger: %s", msg.Payload)
			if stl != nil {
				if err := stl.RunDailySettlement(ctx); err != nil {
					log.Printf("[WORKER] Settlement run failed: %v", err)
				}
			} else {
				log.Println("[WORKER] Skipping — PostgreSQL not connected")
			}
		}
	}
}

// runTickerMode runs settlement on a fixed interval.
func runTickerMode(ctx context.Context, stl *settler.Settler, cfg *config.Config) {
	ticker := time.NewTicker(cfg.TickerInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if stl != nil {
				log.Println("[TICKER] Running scheduled settlement...")
				if err := stl.RunDailySettlement(ctx); err != nil {
					log.Printf("[TICKER] Settlement failed: %v", err)
				}
			}
		}
	}
}

// runDailyScheduler waits for the configured settlement hour and triggers a run.
func runDailyScheduler(ctx context.Context, stl *settler.Settler, cfg *config.Config) {
	for {
		now := time.Now().UTC()
		next := time.Date(now.Year(), now.Month(), now.Day(), cfg.SettlementHour, 0, 0, 0, time.UTC)
		if now.After(next) {
			next = next.Add(24 * time.Hour)
		}
		waitDuration := next.Sub(now)

		log.Printf("[SCHEDULER] Next settlement run at %s (in %v)", next.Format(time.RFC3339), waitDuration.Round(time.Minute))

		select {
		case <-ctx.Done():
			return
		case <-time.After(waitDuration):
			if stl != nil {
				log.Println("[SCHEDULER] Running daily settlement...")
				if err := stl.RunDailySettlement(ctx); err != nil {
					log.Printf("[SCHEDULER] Settlement failed: %v", err)
				}
			}
		}
	}
}

func init() {
	// Print banner
	fmt.Println(`
    _   __                      ____              
   / | / /__  _  ____  ______  / __ \____ ___  __ 
  /  |/ / _ \| |/_/ / / / __ \/ /_/ / __ '/ / / / 
 / /|  /  __/>  </ /_/ / /_/ / ____/ /_/ / /_/ /  
/_/ |_/\___/_/|_|\__,_/ .___/_/    \__,_/\__, /   
                     /_/ Settlement Worker/____/   `)
}
