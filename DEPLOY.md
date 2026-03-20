# NexusPay — Deployment Guide

## Architecture

```
Cloudflare Pages / GitHub Pages    Railway / Render / Fly.io
┌───────────────────────────────┐   ┌────────────────────────────┐
│         FRONTEND              │   │         BACKEND            │
│  /login.html                  │◄──►│  Node.js Express API       │
│  /signup.html                 │   │  SQLite (or PostgreSQL)    │
│  /dashboard/index.html        │   │  POST /api/v1/auth/*       │
│  /pay/index.html              │   │  POST /api/v1/payments/*   │
│  /assets/js/np-utils.js       │   │  POST /api/v1/sms/*        │
│  /config.js  ← edit this!     │   │  GET  /api/v1/merchants/*  │
└───────────────────────────────┘   └────────────────────────────┘
```

---

## Step 1 — Deploy Backend

### Option A: Railway (Recommended — Free tier available)

1. Create account at [railway.app](https://railway.app)
2. New Project → Deploy from GitHub → select your backend folder
3. Set environment variables in Railway dashboard (see `.env.example`)
4. Railway gives you: `https://your-app.railway.app`

### Option B: Render

1. Create account at [render.com](https://render.com)
2. New Web Service → connect GitHub → select backend folder
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Add environment variables from `.env.example`

### Option C: Fly.io

```bash
cd backend
fly launch
fly secrets set JWT_SECRET=your_secret ENCRYPTION_KEY=your_key ...
fly deploy
```

### Required Environment Variables

```bash
NODE_ENV=production
JWT_SECRET=<64+ random chars>
ENCRYPTION_KEY=<32 hex chars>
WEBHOOK_SECRET=<32 hex chars>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
FROM_EMAIL=payments@yourdomain.com
FROM_NAME=Your Platform Name
FRONTEND_URL=https://your-frontend.pages.dev
DB_PATH=/data/nexuspay.db
```

Generate secure secrets:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # WEBHOOK_SECRET
```

---

## Step 2 — Deploy Frontend

### Option A: Cloudflare Pages (Best — automatic `_redirects` support)

1. Go to [pages.cloudflare.com](https://pages.cloudflare.com)
2. Create application → Connect to Git → select your repo
3. Build command: (leave empty — static site)
4. Output directory: `/`
5. Done! You get: `https://yourapp.pages.dev`

### Option B: GitHub Pages

1. Push your code to a GitHub repo
2. Settings → Pages → Source: Deploy from branch → `/` root
3. Your site: `https://yourusername.github.io/repo-name`
4. The `404.html` handles SPA routing for GitHub Pages.

### Option C: Netlify

1. Drag-drop the project folder to [netlify.com/drop](https://app.netlify.com/drop)
2. The `_redirects` file handles all routing automatically.

---

## Step 3 — Connect Frontend to Backend

Edit `config.js` in the root directory:

```javascript
window.NEXUSPAY_API_URL = "https://your-backend.railway.app/api/v1";

window.NEXUSPAY_BRAND = {
  name:    "YourPlatformName",     // shown in "Powered by" footer
  tagline: "Secure Payments",
  website: "https://yourdomain.com",
  support: "support@yourdomain.com",
  color:   "#5b4fff",             // brand color
};
```

---

## Step 4 — Test the Integration

```bash
# 1. Register a merchant
curl -X POST https://your-backend.railway.app/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","phone":"+919876543210","password":"TestPass@123","business_name":"Test Store","business_type":"ecommerce","website":"https://teststore.com"}'

# Save the api_keys.test from the response

# 2. Create a payment
curl -X POST https://your-backend.railway.app/api/v1/payments/create \
  -H "X-NexusPay-Key: vp_test_YOUR_TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{"order_id":"ORD-001","amount":49900,"currency":"INR","customer":{"name":"Arjun","email":"arjun@test.com","phone":"+919999999999"},"description":"Test Payment"}'

# Open the gateway_url from the response in your browser
```

---

## Step 5 — Integrate with Your Application

```javascript
// server.js (your app's backend)
const NexusPay = require('./sdk/node/nexuspay');

const vp = new NexusPay(process.env.NEXUSPAY_API_KEY, {
  baseUrl: process.env.NEXUSPAY_BASE_URL,  // your backend URL
});

// Create a payment
app.post('/checkout', async (req, res) => {
  const payment = await vp.payments.create({
    order_id:     `ORD-${Date.now()}`,
    amount:       req.body.amount * 100,  // convert to paise
    currency:     'INR',
    customer:     { name: req.body.name, email: req.body.email, phone: req.body.phone },
    description:  req.body.description,
    redirect_url: `${process.env.MY_APP_URL}/payment-success`,
    callback_url: `${process.env.MY_APP_URL}/webhook/nexuspay`,
  });
  res.redirect(payment.gateway_url);
});

// Handle webhook
app.post('/webhook/nexuspay', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-nexuspay-signature'];
  if (!NexusPay.verifyWebhookSignature(req.body, sig, process.env.NEXUSPAY_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  const { event, data } = JSON.parse(req.body);
  if (event === 'payment.captured') {
    // Fulfill the order: data.order_id, data.payment_id, data.amount
    console.log('Order paid:', data.order_id);
  }
  res.json({ received: true });
});
```

---

## CORS Configuration

After deploying, add your frontend URL to the backend's `FRONTEND_URL` env variable:

```
FRONTEND_URL=https://yourapp.pages.dev
```

The backend automatically allows this origin.

---

## Payment Flow

```
Customer → Your App → NexusPay API → Checkout Page → Customer pays → 
  ↓                                                                    
Webhook fires to Your App → Fulfill order → Customer sees success
```

---

## Folder Structure

```
.
├── config.js           ← EDIT THIS with your backend URL
├── _redirects          ← Cloudflare Pages routing
├── _headers            ← Security headers
├── login.html
├── signup.html
├── 404.html
├── dashboard/index.html
├── pay/index.html
├── assets/
│
├── backend/                → Deploy to Railway/Render/Fly.io
│   ├── server.js
│   ├── .env.example        ← Copy to .env and fill in
│   └── src/
│
├── sdk/
│   ├── node/nexuspay.js    → Copy to your Node.js project
│   ├── python/nexuspay.py  → Copy to your Python project
│   └── php/NexusPay.php    → Copy to your PHP project
│
└── DEPLOY.md               ← This file
```
