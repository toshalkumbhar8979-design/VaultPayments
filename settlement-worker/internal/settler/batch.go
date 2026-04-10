package settler

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"nexuspay-settlement-worker/internal/config"
)

// Batch represents a settlement batch for a single merchant.
type Batch struct {
	ID           string
	MerchantID   string
	BatchDate    string
	TotalAmount  int64
	FeeDeducted  int64
	NetPayout    int64
	PaymentCount int
	Status       string
	PayoutMethod string
	PayoutRef    string
	BankAccount  string
	IFSCCode     string
}

// Settler handles the creation and processing of settlement batches.
type Settler struct {
	pool   *pgxpool.Pool
	cfg    *config.Config
	payout *PayoutService
}

// NewSettler creates a new Settler instance.
func NewSettler(pool *pgxpool.Pool, cfg *config.Config) *Settler {
	return &Settler{
		pool:   pool,
		cfg:    cfg,
		payout: NewPayoutService(cfg),
	}
}

// RunDailySettlement scans for captured payments ready for settlement
// and creates batches per merchant.
func (s *Settler) RunDailySettlement(ctx context.Context) error {
	log.Println("[SETTLER] Starting daily settlement run...")

	// 1. Find merchants with unsettled captured payments older than T+1
	cutoff := time.Now().Add(-s.cfg.SettlementDelay)
	cutoffStr := cutoff.Format(time.RFC3339)

	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT merchant_id 
		FROM ledger_entries le
		JOIN ledger_accounts la ON le.account_id = la.id
		WHERE la.account_type = 'merchant' 
		  AND la.available_balance > 0
		  AND le.created_at < $1
	`, cutoffStr)
	if err != nil {
		return fmt.Errorf("failed to find settleable merchants: %w", err)
	}
	defer rows.Close()

	var merchantIDs []string
	for rows.Next() {
		var mid string
		if err := rows.Scan(&mid); err != nil {
			continue
		}
		merchantIDs = append(merchantIDs, mid)
	}

	log.Printf("[SETTLER] Found %d merchants with pending settlements", len(merchantIDs))

	// 2. Create batch for each merchant
	for _, merchantID := range merchantIDs {
		if err := s.createBatch(ctx, merchantID); err != nil {
			log.Printf("[SETTLER] Failed to create batch for %s: %v", merchantID, err)
			continue
		}
	}

	// 3. Process pending batches
	return s.processPendingBatches(ctx)
}

// createBatch creates a settlement batch for a merchant.
func (s *Settler) createBatch(ctx context.Context, merchantID string) error {
	batchDate := time.Now().Format("2006-01-02")
	batchID := uuid.New().String()

	// Get merchant's available balance
	var totalBalance, frozenFunds int64
	err := s.pool.QueryRow(ctx, `
		SELECT total_balance, frozen_funds 
		FROM ledger_accounts 
		WHERE merchant_id = $1 AND account_type = 'merchant'
	`, merchantID).Scan(&totalBalance, &frozenFunds)
	if err != nil {
		return fmt.Errorf("failed to get balance: %w", err)
	}

	availableBalance := totalBalance - frozenFunds
	if availableBalance <= 0 {
		log.Printf("[SETTLER] No available balance for %s, skipping", merchantID)
		return nil
	}

	// Determine payout method based on amount
	payoutMethod := s.cfg.PayoutMethod
	if availableBalance < s.cfg.IMPSThreshold {
		payoutMethod = "IMPS"
	}

	// Create batch record
	_, err = s.pool.Exec(ctx, `
		INSERT INTO settlement_batches 
			(id, merchant_id, batch_date, total_amount, fee_deducted, net_payout, 
			 payment_count, status, payout_method)
		VALUES ($1, $2, $3, $4, 0, $4, 0, 'pending', $5)
		ON CONFLICT (merchant_id, batch_date) DO NOTHING
	`, batchID, merchantID, batchDate, availableBalance, payoutMethod)
	if err != nil {
		return fmt.Errorf("failed to create batch: %w", err)
	}

	// Freeze the funds
	_, err = s.pool.Exec(ctx, `
		UPDATE ledger_accounts 
		SET frozen_funds = frozen_funds + $1 
		WHERE merchant_id = $2 AND account_type = 'merchant'
	`, availableBalance, merchantID)
	if err != nil {
		return fmt.Errorf("failed to freeze funds: %w", err)
	}

	log.Printf("[SETTLER] Created batch %s for merchant %s: amount=%d, method=%s",
		batchID, merchantID, availableBalance, payoutMethod)

	return nil
}

// processPendingBatches processes all pending settlement batches.
func (s *Settler) processPendingBatches(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT id, merchant_id, total_amount, net_payout, payout_method 
		FROM settlement_batches 
		WHERE status = 'pending'
		ORDER BY created_at ASC
		LIMIT $1
	`, s.cfg.BatchSize)
	if err != nil {
		return fmt.Errorf("failed to query pending batches: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var batch Batch
		if err := rows.Scan(&batch.ID, &batch.MerchantID, &batch.TotalAmount,
			&batch.NetPayout, &batch.PayoutMethod); err != nil {
			continue
		}

		if err := s.processBatch(ctx, &batch); err != nil {
			log.Printf("[SETTLER] Failed to process batch %s: %v", batch.ID, err)
			// Mark batch as failed
			s.pool.Exec(ctx, `
				UPDATE settlement_batches SET status = 'failed', error_message = $1 WHERE id = $2
			`, err.Error(), batch.ID)
		}
	}

	return nil
}

// processBatch executes payout for a single batch.
func (s *Settler) processBatch(ctx context.Context, batch *Batch) error {
	// Update status to processing
	_, err := s.pool.Exec(ctx, `
		UPDATE settlement_batches SET status = 'processing' WHERE id = $1
	`, batch.ID)
	if err != nil {
		return err
	}

	log.Printf("[SETTLER] Processing batch %s: merchant=%s, amount=%d, method=%s",
		batch.ID, batch.MerchantID, batch.NetPayout, batch.PayoutMethod)

	// Get merchant bank details (from SQLite merchant table, passed via Redis or config)
	// For now, use batch's stored details or mock
	payoutResult, err := s.payout.ExecutePayout(ctx, &PayoutRequest{
		BatchID:      batch.ID,
		MerchantID:   batch.MerchantID,
		Amount:       batch.NetPayout,
		Method:       batch.PayoutMethod,
		BankAccount:  batch.BankAccount,
		IFSCCode:     batch.IFSCCode,
	})
	if err != nil {
		return fmt.Errorf("payout execution failed: %w", err)
	}

	if payoutResult.Success {
		// Mark batch as completed
		_, err = s.pool.Exec(ctx, `
			UPDATE settlement_batches 
			SET status = 'completed', payout_ref = $1, completed_at = NOW() 
			WHERE id = $2
		`, payoutResult.PayoutRef, batch.ID)
		if err != nil {
			return err
		}

		// Release frozen funds and debit merchant account
		txnID := uuid.New().String()

		// Debit merchant account
		_, err = s.pool.Exec(ctx, `
			UPDATE ledger_accounts 
			SET total_balance = total_balance - $1, frozen_funds = frozen_funds - $1
			WHERE merchant_id = $2 AND account_type = 'merchant'
		`, batch.NetPayout, batch.MerchantID)
		if err != nil {
			return fmt.Errorf("failed to debit merchant account: %w", err)
		}

		// Record settlement ledger entry
		entryID := uuid.New().String()
		_, err = s.pool.Exec(ctx, `
			INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, running_balance, description)
			SELECT $1, $2, id, 'DEBIT', $3, total_balance, $4
			FROM ledger_accounts WHERE merchant_id = $5 AND account_type = 'merchant'
		`, entryID, txnID, batch.NetPayout, fmt.Sprintf("Settlement payout batch %s", batch.ID), batch.MerchantID)
		if err != nil {
			log.Printf("[SETTLER] Warning: failed to record ledger entry: %v", err)
		}

		log.Printf("[SETTLER] ✅ Batch %s completed: payout_ref=%s", batch.ID, payoutResult.PayoutRef)
	} else {
		// Mark as failed
		_, err = s.pool.Exec(ctx, `
			UPDATE settlement_batches SET status = 'failed', error_message = $1 WHERE id = $2
		`, payoutResult.Message, batch.ID)

		// Unfreeze funds
		s.pool.Exec(ctx, `
			UPDATE ledger_accounts 
			SET frozen_funds = frozen_funds - $1
			WHERE merchant_id = $2 AND account_type = 'merchant'
		`, batch.NetPayout, batch.MerchantID)

		return fmt.Errorf("payout failed: %s", payoutResult.Message)
	}

	return nil
}
