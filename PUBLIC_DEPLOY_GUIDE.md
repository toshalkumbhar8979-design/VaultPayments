# 🌐 NexusPay: Public Deployment Guide

Deploying NexusPay for the public requires two main steps: deploying your Node.js Backend API and deploying your Frontend static files. Since the system uses a PostgreSQL ledger and a Go settlement worker, you have a few strategies for deployment depending on your scale.

---

## 1️⃣ The "All-in-One" VPS Approach (Easiest)
*Best for getting started quickly with full control.*

If you rent a single virtual server (e.g., DigitalOcean Droplet, AWS EC2, or Hetzner) running Ubuntu:

1. **Install Docker and Docker Compose.**
2. **Create a `docker-compose.yml`** file in your repo root that includes Postgres, Redis, your Node.js backend, and the Go Settlement worker.
3. Add a reverse proxy like **Nginx** or **Caddy** to route incoming traffic on ports 80/443 to the Node.js backend port (5000), and automatically handle free SSL certificates via Let's Encrypt.
4. Set your `config.js` in the frontend to point to your new domain: `https://api.yourdomain.com/api/v1`

---

## 2️⃣ The "Managed Cloud" Approach (Most Reliable)
*Best for scaling and avoiding manual server maintenance.*

### A. The Backend (Railway / Render / Fly.io)
Services like Railway.app or Render.com are perfect for the backend API.
1. Connect your Github Repository to **Railway.app**.
2. Click **Add Plugin** and add a managed **PostgreSQL Database** and **Redis** database via their dashboard.
3. Deploy the backend folder to Railway. It will automatically detect `package.json`, install dependencies, and start `server.js`.
4. Deploy the `settlement-worker` folder to Railway as a secondary service, attaching the Redis and Postgres URIs. 

### B. The Frontend (Cloudflare Pages / Vercel / Netlify)
Since the dashboard and checkout pages (`index.html`, `dashboard/`, `pay/`) are completely static HTML/JS/CSS:
1. Go to **Cloudflare Pages** or **Vercel**.
2. Connect your repository.
3. Set the build folder to the root director `/` (or wherever your HTML files are).
4. Cloudflare automatically hosts this globally via their CDN for free.

---

## 3️⃣ Security Checklist for Public Traffic
Before announcing your gateway to the public, ensure these are configured:

- [ ] **Strong Secrets:** Update your `.env` file! Change `JWT_SECRET`, `ENCRYPTION_KEY`, and `WEBHOOK_SECRET` to long, random cryptographic strings. Do not use defaults.
- [ ] **DISABLE Sandbox Mode:** Ensure `BANK_SANDBOX_MODE=false` in your environment variables so the NativeAcquirer processes real cards instead of the mock bank.
- [ ] **Turn on HTTPS Enforcements:** The backend `server.js` supports `trust proxy`. Make sure all frontend `<script>` and `<link>` tags use `https://`.
- [ ] **Rate Limiting:** The backend uses `express-rate-limit`. Ensure your proxy (like Nginx) passes the correct `X-Forwarded-For` headers so rate-limiting is applied by client IP rather than the proxy's IP. 

## 4️⃣ Connecting Merchants
Once deployed:
1. Update `FRONTEND_URL` in your backend `.env` so CORS allows your dashboard domain.
2. Tell your merchants to sign up at `https://yourdomain.com/signup.html`.
3. They configure their keys via `https://yourdomain.com/dashboard/#gateways`.
