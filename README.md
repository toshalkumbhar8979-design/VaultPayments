# ⚡ NexusPay — Complete Payment Service Provider (PSP)

The developer-first payment gateway that operates as a Primary Payment Processor. Features a Double-Entry Ledger (PostgreSQL), ISO 8583 Native Acquirer engine, Settlement Worker (Go), and a complete merchant dashboard with PCI audit capabilities, orchestration, and a Stripe-like checkout experience.

## 🏗️ Architecture

NexusPay operates in a microservices architecture:
1. **Frontend (Dashboard & Checkout)**: HTML/JS/CSS served via Express or any static host.
2. **Backend API (Node.js)**: Holds the core state machine, PCI vault, API key management, and Native Acquirer.
3. **Database (Hybrid)**: SQLite for basic config/metadata + PostgreSQL for high-concurrency ACID-compliant Double-entry ledgers.
4. **Settlement Worker (Go)**: High-concurrency background job processor utilizing Redis to batch and trigger daily IMPS/NEFT payouts.

---

## ⚡ Quick Start & Run Commands

### Prerequisites
Make sure you have the following installed on your machine:
- Node.js (v18+)
- Go (v1.21+)
- PostgreSQL (or Docker)
- Redis (or Docker)

### 1. Start External Dependencies (Docker)
The easiest way to run PostgreSQL and Redis locally without installing them is via Docker.
```bash
# Start Redis
docker run -d -p 6379:6379 --name nexuspay-redis redis

# Start PostgreSQL
docker run -d -p 5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=your_password -e POSTGRES_DB=nexuspay --name nexuspay-pg postgres
```
*(If you have native installations, ensure Redis runs on port `6379` and PostgreSQL on `5432`)*

---

### 2. Run the Node.js Backend & Dashboard
This starts the core API, the Webhook dispatcher, and statically serves the Front-end dashboard.

```bash
cd backend
npm install

# (Optional) Edit your .env file here based on .env.example

node server.js
```
**Access URLs:**
- **Landing Page:** [http://localhost:5000/](http://localhost:5000/)
- **Sign In:** [http://localhost:5000/login.html](http://localhost:5000/login.html) 
- **Dashboard:** [http://localhost:5000/dashboard/](http://localhost:5000/dashboard/)

*(Note: The server uses an in-memory fallback for the ledger if PostgreSQL is not connected, but for real transactions, ensure Postgres is running).*

---

### 3. Run the Go Settlement Worker
The Settlement Worker is responsible for taking daily batches of settled transactions from PostgreSQL and routing payouts to merchant bank accounts.

Open a **new terminal window** and run:
```bash
cd settlement-worker

# Install Go dependencies (only needed the first time)
go mod tidy

# Required Environment Variables
export REDIS_ADDR=localhost:6379
export PG_HOST=localhost
export PG_PORT=5432
export PG_DATABASE=nexuspay
export PG_USER=postgres
export PG_PASSWORD=your_password

# Run the worker process
go run ./cmd/worker/
```
*(On Windows Powershell, use `$env:REDIS_ADDR="localhost:6379"` instead of `export`)*

---

## 📁 Repository Structure

```text
.
├── config.js            ← Frontend config (API paths, brand colors)
├── index.html           → Marketing Landing Page
├── login.html           → Sign in
├── signup.html          → Registration
├── onboarding.html      → Merchant KYC & Platform selection
├── dashboard/           → Complete Merchant Dashboard SPA
├── pay/                 → Hosted Checkout Page UI
│
├── backend/             → Node.js Core API Server
│   ├── server.js        ← Main Entrypoint
│   ├── data/            ← SQLite databases (Metadata + PCI Vault)
│   └── src/
│       ├── connectors/  → Payment Integrations (Native, UPI, Paypal, Fake Card)
│       ├── controllers/ → API implementation 
│       ├── middleware/  → Auth, Idempotency, Validation, Webhooks
│       └── services/    → LedgerService, StateMachine, QR, Crypto
│
├── settlement-worker/   → Go Microservice for Payouts
│   ├── cmd/worker/      ← Main Entrypoint (main.go)
│   └── internal/        ← Worker core logic (config, batch, payout)
│
└── sdk/                 → Official Integration SDKs
    ├── node/            → Javascript
    ├── python/          → Python
    └── php/             → PHP
```

## ✨ Core Features Added

1. **Native Acquirer**: Bypasses third-party SDKs using a custom ISO 8583 bridge.
2. **Double-Entry Ledger (Postgres)**: Ensures `SUM(debits) == SUM(credits)` with `SERIALIZABLE` isolation.
3. **Optimistic Locking**: State Machine prevents race conditions (Created → Authorized → Captured → Settled).
4. **Idempotency Keys**: All API requests require idempotency tokens mapping to PostgreSQL hashes to stop duplicate charges.
5. **PCI-Compliance Engine**: Dedicated zero-logging ephemeral tokenization system.
6. **Smart Orchestration**: Dynamic routing engine evaluated by priority conditions (e.g. `method == 'upi'`).
7. **Test vs Live Mode**: Toggles dashboard state between sandbox isolation and production API banks.

## 🔗 Documentation

- See `DEPLOY.md` for production cloud deployment steps (Railway, Render, AWS).
- See `STORE_SETUP_QUICKSTART.md` for instructions on integrating NexusPay into a user's storefront using the provided SDK scripts.
- Go to `Knowledge Hub` inside the Dashboard for PSP Architectural details.
