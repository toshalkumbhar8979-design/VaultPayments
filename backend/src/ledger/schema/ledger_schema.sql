-- ============================================================================
-- NexusPay Double-Entry Ledger Schema
-- PostgreSQL 14+ required
-- 
-- DESIGN PRINCIPLES:
--   1. Every financial movement creates TWO entries (DEBIT + CREDIT)
--   2. SUM(debits) MUST equal SUM(credits) for every transaction_id
--   3. Ledger entries are IMMUTABLE — never UPDATE, only INSERT
--   4. Balances are maintained via triggers for O(1) reads
--   5. Idempotency keys prevent duplicate processing
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Ledger Accounts ─────────────────────────────────────────────────────────
-- Every entity that can hold money gets an account.
-- System accounts: 'platform_fee', 'settlement_pool', 'suspense'
-- Merchant accounts: one per merchant per currency

CREATE TABLE IF NOT EXISTS ledger_accounts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_type      VARCHAR(20) NOT NULL CHECK (account_type IN (
                        'merchant',          -- Merchant virtual balance
                        'customer_source',   -- Customer payment source (transient)
                        'platform_fee',      -- NexusPay fee collection
                        'settlement_pool',   -- Funds awaiting payout
                        'suspense',          -- Held funds (disputes, freezes)
                        'refund_reserve'     -- Reserved for potential refunds
                      )),
    merchant_id       VARCHAR(64),          -- NULL for system accounts
    currency          VARCHAR(3) NOT NULL DEFAULT 'INR',
    total_balance     BIGINT NOT NULL DEFAULT 0,   -- in minor units (paise/cents)
    frozen_funds      BIGINT NOT NULL DEFAULT 0,
    available_balance BIGINT GENERATED ALWAYS AS (total_balance - frozen_funds) STORED,
    metadata          JSONB DEFAULT '{}',
    is_active         BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT positive_frozen CHECK (frozen_funds >= 0),
    CONSTRAINT frozen_lte_total CHECK (frozen_funds <= total_balance)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_acct_merchant 
    ON ledger_accounts(merchant_id, currency) 
    WHERE merchant_id IS NOT NULL AND account_type = 'merchant';

CREATE INDEX IF NOT EXISTS idx_ledger_acct_type ON ledger_accounts(account_type);

-- ── Ledger Entries (The Immutable Journal) ──────────────────────────────────
-- Every row is ONE side of a double-entry. For every DEBIT there MUST be
-- a matching CREDIT with the same transaction_id.

CREATE TABLE IF NOT EXISTS ledger_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  UUID NOT NULL,                -- Groups DEBIT+CREDIT pair(s)
    payment_id      VARCHAR(64),                  -- Reference to payments table
    account_id      UUID NOT NULL REFERENCES ledger_accounts(id),
    entry_type      VARCHAR(6) NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
    amount          BIGINT NOT NULL CHECK (amount > 0),  -- Always positive
    running_balance BIGINT NOT NULL,              -- Account balance AFTER this entry
    description     TEXT DEFAULT '',
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate entries for same transaction+account+type
    CONSTRAINT unique_entry_per_txn UNIQUE (transaction_id, account_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_le_transaction ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_le_payment     ON ledger_entries(payment_id);
CREATE INDEX IF NOT EXISTS idx_le_account     ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_le_created     ON ledger_entries(created_at);

-- ── Idempotency Keys ────────────────────────────────────────────────────────
-- Prevents double-processing of the same request.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key             VARCHAR(128) PRIMARY KEY,
    request_path    VARCHAR(256) NOT NULL,
    request_hash    VARCHAR(64) NOT NULL,         -- SHA-256 of request body
    status          VARCHAR(20) NOT NULL DEFAULT 'processing'
                      CHECK (status IN ('processing', 'completed', 'failed')),
    response_code   INTEGER,
    response_body   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at);

-- ── Settlement Batches ──────────────────────────────────────────────────────
-- Tracks daily settlement runs to merchant bank accounts.

CREATE TABLE IF NOT EXISTS settlement_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     VARCHAR(64) NOT NULL,
    batch_date      DATE NOT NULL,
    total_amount    BIGINT NOT NULL DEFAULT 0,     -- Total payout amount
    fee_deducted    BIGINT NOT NULL DEFAULT 0,
    net_payout      BIGINT NOT NULL DEFAULT 0,
    payment_count   INTEGER NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'reversed')),
    payout_method   VARCHAR(10) DEFAULT 'NEFT'
                      CHECK (payout_method IN ('IMPS', 'NEFT', 'RTGS', 'ACH', 'UPI')),
    payout_ref      VARCHAR(128) DEFAULT '',       -- Bank reference number
    bank_account    VARCHAR(20) DEFAULT '',
    ifsc_code       VARCHAR(11) DEFAULT '',
    error_message   TEXT DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,

    CONSTRAINT unique_batch UNIQUE (merchant_id, batch_date)
);

CREATE INDEX IF NOT EXISTS idx_sb_status ON settlement_batches(status);
CREATE INDEX IF NOT EXISTS idx_sb_date   ON settlement_batches(batch_date);

-- ── Webhook Deliveries ──────────────────────────────────────────────────────
-- Tracks outbound webhook delivery to merchants.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     VARCHAR(64) NOT NULL,
    event_type      VARCHAR(64) NOT NULL,
    payment_id      VARCHAR(64),
    payload         JSONB NOT NULL,
    webhook_url     TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
    http_status     INTEGER,
    response_body   TEXT DEFAULT '',
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    next_retry_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wd_merchant ON webhook_deliveries(merchant_id);
CREATE INDEX IF NOT EXISTS idx_wd_status   ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_wd_retry    ON webhook_deliveries(next_retry_at) WHERE status = 'retrying';

-- ── Merchant Fee Rates ──────────────────────────────────────────────────────
-- Per-merchant rate configuration for fee calculation.

CREATE TABLE IF NOT EXISTS merchant_fee_rates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     VARCHAR(64) NOT NULL,
    payment_method  VARCHAR(20) NOT NULL,          -- 'card', 'upi', 'netbanking', 'wallet'
    rate_type       VARCHAR(10) NOT NULL DEFAULT 'percentage'
                      CHECK (rate_type IN ('percentage', 'flat', 'blended')),
    rate_value      NUMERIC(8,4) NOT NULL,         -- e.g., 2.0000 for 2%
    flat_fee        BIGINT DEFAULT 0,              -- Flat fee in minor units
    min_fee         BIGINT DEFAULT 0,
    max_fee         BIGINT DEFAULT 0,              -- 0 = no cap
    gst_rate        NUMERIC(5,2) DEFAULT 18.00,    -- GST on fees (India: 18%)
    currency        VARCHAR(3) DEFAULT 'INR',
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_merchant_method UNIQUE (merchant_id, payment_method, currency)
);

-- ── Payment State Audit Trail ───────────────────────────────────────────────
-- Every state transition is recorded for compliance and debugging.

CREATE TABLE IF NOT EXISTS payment_state_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      VARCHAR(64) NOT NULL,
    from_state      VARCHAR(30) NOT NULL,
    to_state        VARCHAR(30) NOT NULL,
    trigger         VARCHAR(64) DEFAULT '',        -- What caused the transition
    actor           VARCHAR(64) DEFAULT 'system',  -- 'system', 'merchant', 'customer'
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_psl_payment ON payment_state_log(payment_id);
CREATE INDEX IF NOT EXISTS idx_psl_created ON payment_state_log(created_at);

-- ── Functions & Triggers ────────────────────────────────────────────────────

-- Auto-update ledger_accounts.updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_accounts_updated ON ledger_accounts;
CREATE TRIGGER trg_ledger_accounts_updated
    BEFORE UPDATE ON ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Cleanup expired idempotency keys (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_idempotency_keys()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM idempotency_keys WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
