package settler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"nexuspay-settlement-worker/internal/config"
)

// PayoutRequest represents a payout to a merchant's bank account.
type PayoutRequest struct {
	BatchID         string
	MerchantID      string
	Amount          int64  // Minor units (paise)
	Method          string // "IMPS", "NEFT", "RTGS", "ACH"
	BankAccount     string
	IFSCCode        string
	BeneficiaryName string
}

// PayoutResult represents the result of a payout attempt.
type PayoutResult struct {
	Success   bool
	PayoutRef string
	Status    string
	Message   string
}

// PayoutService handles fund transfers to merchant bank accounts.
type PayoutService struct {
	cfg        *config.Config
	httpClient *http.Client
}

// NewPayoutService creates a new PayoutService.
func NewPayoutService(cfg *config.Config) *PayoutService {
	return &PayoutService{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// ExecutePayout sends a payout to the merchant's bank account.
// In sandbox mode, simulates the bank API response.
func (p *PayoutService) ExecutePayout(ctx context.Context, req *PayoutRequest) (*PayoutResult, error) {
	if p.cfg.SandboxMode {
		return p.executeSandboxPayout(ctx, req)
	}
	return p.executeLivePayout(ctx, req)
}

// executeSandboxPayout simulates a bank payout API.
func (p *PayoutService) executeSandboxPayout(ctx context.Context, req *PayoutRequest) (*PayoutResult, error) {
	log.Printf("[PAYOUT-SANDBOX] Processing %s payout: merchant=%s, amount=%d paise",
		req.Method, req.MerchantID, req.Amount)

	// Simulate processing delay
	time.Sleep(500 * time.Millisecond)

	// Simulate failure for very large amounts (> ₹10,00,000)
	if req.Amount > 100000000 {
		return &PayoutResult{
			Success:   false,
			PayoutRef: "",
			Status:    "FAILED",
			Message:   "Payout limit exceeded (sandbox)",
		}, nil
	}

	// Generate mock payout reference
	payoutRef := fmt.Sprintf("NXPY-%s-%s", strings.ToUpper(req.Method), uuid.New().String()[:8])

	log.Printf("[PAYOUT-SANDBOX] ✅ Payout approved: ref=%s, amount=₹%.2f",
		payoutRef, float64(req.Amount)/100)

	return &PayoutResult{
		Success:   true,
		PayoutRef: payoutRef,
		Status:    "COMPLETED",
		Message:   fmt.Sprintf("Sandbox %s payout completed", req.Method),
	}, nil
}

// executeLivePayout calls the sponsor bank's payout API.
// Designed for ICICI/Suryoday bank APIs.
func (p *PayoutService) executeLivePayout(ctx context.Context, req *PayoutRequest) (*PayoutResult, error) {
	// Build bank API request
	bankReq := map[string]interface{}{
		"transaction_id":   req.BatchID,
		"beneficiary_acct": req.BankAccount,
		"beneficiary_ifsc": req.IFSCCode,
		"beneficiary_name": req.BeneficiaryName,
		"amount":           float64(req.Amount) / 100, // Convert paise to rupees
		"currency":         "INR",
		"transfer_mode":    req.Method,
		"purpose":          "MERCHANT_SETTLEMENT",
		"narration":        fmt.Sprintf("NexusPay Settlement %s", req.BatchID[:8]),
	}

	body, err := json.Marshal(bankReq)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Sign request
	signature := p.signRequest(body)

	// Send to bank API
	httpReq, err := http.NewRequestWithContext(ctx, "POST",
		p.cfg.BankAPIBaseURL+"/v1/transfers",
		strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-API-Key", p.cfg.BankAPIKey)
	httpReq.Header.Set("X-Signature", signature)
	httpReq.Header.Set("X-Idempotency-Key", req.BatchID)

	resp, err := p.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("bank API call failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Parse response
	var bankResp struct {
		Success    bool   `json:"success"`
		PayoutRef  string `json:"payout_ref"`
		Status     string `json:"status"`
		Message    string `json:"message"`
		ErrorCode  string `json:"error_code"`
	}

	if err := json.Unmarshal(respBody, &bankResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return &PayoutResult{
			Success:   false,
			Status:    "FAILED",
			Message:   fmt.Sprintf("Bank API error %d: %s", resp.StatusCode, bankResp.Message),
		}, nil
	}

	return &PayoutResult{
		Success:   bankResp.Success,
		PayoutRef: bankResp.PayoutRef,
		Status:    bankResp.Status,
		Message:   bankResp.Message,
	}, nil
}

// signRequest creates HMAC-SHA256 signature for the bank API.
func (p *PayoutService) signRequest(body []byte) string {
	mac := hmac.New(sha256.New, []byte(p.cfg.BankAPISecret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
