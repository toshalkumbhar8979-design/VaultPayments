# ⚡ NexusPay — Complete Payment Gateway Platform

The developer-first payment gateway. QR codes, UPI, SMS acknowledgement, white-label checkout, 3 SDKs.

## ⚡ Quick Setup

### 1. Deploy Backend (5 minutes)
```bash
cd backend
npm install
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET, ENCRYPTION_KEY, WEBHOOK_SECRET, SMTP_*, FRONTEND_URL
node server.js
```

### 2. Configure Frontend
Edit `config.js` in the root directory:
```javascript
window.NEXUSPAY_API_URL = "https://your-backend.railway.app/api/v1";
window.NEXUSPAY_BRAND   = { name: "YourPlatformName", color: "#5b4fff" };
```

### 3. Deploy Frontend
- **Cloudflare Pages**: Connect GitHub repo → deploy
- **Netlify**: Drag-drop the project folder
- **GitHub Pages**: Push to repo → enable Pages

### 4. Visit Your Platform
- `https://your-frontend.pages.dev/` → Marketing website
- `https://your-frontend.pages.dev/signup.html` → Create merchant account
- `https://your-frontend.pages.dev/dashboard/` → Merchant dashboard

## 📁 Structure

```
.
├── config.js        ← EDIT THIS with your backend URL
├── index.html       → Marketing website
├── login.html       → Login page
├── signup.html      → Multi-step registration
├── dashboard/       → Merchant dashboard SPA
├── pay/             → Customer checkout page
├── assets/css/      → Shared styles
├── assets/js/       → Shared utilities
├── _redirects       → Cloudflare/Netlify routing
├── _headers         → Security headers
│
├── backend/             → Node.js API (Railway / Render / Fly.io)
│   ├── server.js
│   ├── .env.example     ← Copy → .env
│   └── src/
│       ├── config/      → database.js (SQLite), constants.js
│       ├── controllers/ → auth, payment, merchant, sms
│       ├── middleware/  → auth, security, rate-limit, validation
│       ├── routes/      → all API routes
│       ├── services/    → qr, email, crypto
│       └── utils/       → logger, response, apiKey
│
├── sdk/
│   ├── node/            → Node.js SDK (zero deps)
│   ├── python/          → Python SDK (stdlib only)
│   └── php/             → PHP SDK (cURL only)
│
├── DEPLOY.md            → Step-by-step deployment guide
└── README.md            → This file
```

## 🔗 API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | None | Register merchant |
| POST | `/auth/login` | None | Login |
| POST | `/auth/rotate-keys` | JWT | Rotate API keys |
| POST | `/payments/create` | API Key | Create payment |
| GET | `/payments` | API Key | List payments |
| GET | `/payments/:id` | API Key | Get payment |
| GET | `/payments/checkout/:id` | None | Checkout data (public) |
| POST | `/payments/:id/capture` | API Key | Capture payment |
| POST | `/payments/:id/refund` | API Key | Refund payment |
| POST | `/sms/parse` | API Key | Parse bank SMS |
| POST | `/qr/generate` | API Key | Generate QR |
| GET | `/merchants/me` | JWT | Get profile |
| PUT | `/merchants/me` | JWT | Update profile |
| GET | `/merchants/dashboard` | JWT | Dashboard stats |

## 🔐 Security

- Passwords: `bcrypt` cost 12
- API Keys: `bcrypt`-hashed, stored as hash only
- Data: `AES-256-GCM` encryption
- Webhooks: `HMAC-SHA256` signed + timing-safe comparison
- Transport: HTTPS enforced, HSTS headers
- Input: `xss` sanitization + SQL injection detection
- Rate Limiting: Per-key + per-IP
- Body Size: 10KB max

See `DEPLOY.md` for full deployment instructions.
